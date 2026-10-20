'use strict';
// A stand-in for Google's OAuth/OIDC endpoints and the Google Tasks API, for tests only.
const http = require('node:http');
const crypto = require('node:crypto');

async function startMockGoogle() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); // for "wrong signature" tests
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const refreshTokens = new Map(); // refresh token -> sub
  const accessTokens = new Map();  // access token -> sub
  const taskStore = new Map();     // sub -> [{ id, title, items: [task] }]
  let origin = '';
  let seq = 0;
  const token = (kind) => `${kind}-${++seq}-${crypto.randomBytes(6).toString('hex')}`;

  const mock = {
    clientId: 'test-client', clientSecret: 'test-secret',
    // who "signs in" next; tests replace this
    identity: { sub: 'sub-1', email: 'student@school.test', email_verified: true, given_name: 'Sam', family_name: 'Student', name: 'Sam Student', hd: 'school.test' },
    // tweaks applied to the next id_token (wrong aud, expired, ...)
    claimOverrides: {},
    denyNext: false,
    // connecting Google Tasks: the scope Google says was granted (null = what was asked for), and
    // whether to leave out the refresh token
    grantScope: null,
    noRefreshToken: false,
    revoked: [],      // tokens apps asked Google to revoke
    tasksCalls: 0,
    tokenCalls: 0,
    jwksCalls: 0,
    get origin() { return origin; },
    signToken(claims, { key = privateKey, header = {} } = {}) {
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid, ...header })).toString('base64url');
      const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
      return `${h}.${p}.${sig}`;
    },
    baseClaims(nonce, now = Math.floor(Date.now() / 1000)) {
      return { iss: origin, aud: mock.clientId, iat: now, exp: now + 3600, nonce, ...mock.identity };
    },
    wrongKey: other.privateKey,
    // The fake Google Tasks data for one account (created on first use with a "My Tasks" list).
    tasksOf(sub) {
      if (!taskStore.has(sub)) taskStore.set(sub, [{ id: 'list-main', title: 'My Tasks', items: [] }]);
      return taskStore.get(sub);
    },
    addTask(sub, task, listId = 'list-main') {
      const t = { id: `task${++seq}`, status: 'needsAction', webViewLink: `https://tasks.google.com/task/x${seq}`, ...task };
      mock.tasksOf(sub).find((l) => l.id === listId).items.push(t);
      return t;
    },
    // As if the person removed MHS Today's access in their Google account settings.
    revokeAll(sub) {
      for (const m of [refreshTokens, accessTokens]) for (const [k, v] of m) if (v === sub) m.delete(k);
    },
    // Expire every access token (the next call has to refresh).
    expireAccessTokens() { accessTokens.clear(); },
    // Point an app config at this mock.
    configure(config) {
      config.google = {
        clientId: mock.clientId, clientSecret: mock.clientSecret,
        authUrl: `${origin}/auth`, tokenUrl: `${origin}/token`, jwksUrl: `${origin}/certs`, issuers: [origin],
        revokeUrl: `${origin}/revoke`, tasksApi: `${origin}/tasks/v1`
      };
    },
    close() { return new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === '/auth') {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri');
      const cb = new URL(redirectUri);
      if (mock.denyNext) { mock.denyNext = false; cb.searchParams.set('error', 'access_denied'); }
      else {
        const code = crypto.randomBytes(12).toString('hex');
        codes.set(code, {
          clientId: q.get('client_id'), redirectUri, nonce: q.get('nonce'), challenge: q.get('code_challenge'),
          method: q.get('code_challenge_method'), identity: { ...mock.identity }, query: Object.fromEntries(q)
        });
        mock.lastAuthQuery = Object.fromEntries(q);
        cb.searchParams.set('code', code);
      }
      cb.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: cb.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        mock.tokenCalls++;
        const f = new URLSearchParams(raw);
        const fail = (error) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error })); };
        const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (f.get('grant_type') === 'refresh_token') {
          if (f.get('client_id') !== mock.clientId || f.get('client_secret') !== mock.clientSecret) return fail('invalid_client');
          const sub = refreshTokens.get(f.get('refresh_token'));
          if (!sub) return fail('invalid_grant');
          const access = token('access');
          accessTokens.set(access, sub);
          return json({ access_token: access, expires_in: 3599, token_type: 'Bearer' });
        }
        const entry = codes.get(f.get('code'));
        if (!entry) return fail('invalid_grant');
        codes.delete(f.get('code')); // single use
        if (f.get('client_id') !== mock.clientId || f.get('client_secret') !== mock.clientSecret) return fail('invalid_client');
        if (f.get('redirect_uri') !== entry.redirectUri || f.get('grant_type') !== 'authorization_code') return fail('invalid_grant');
        const challenge = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
        if (entry.method !== 'S256' || challenge !== entry.challenge) return fail('invalid_grant');
        const claims = { ...mock.baseClaims(entry.nonce), ...entry.identity, ...mock.claimOverrides };
        for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
        const scope = mock.grantScope || entry.query.scope;
        const access = token('access');
        accessTokens.set(access, claims.sub);
        const body = { access_token: access, expires_in: 3599, scope, token_type: 'Bearer', id_token: mock.signToken(claims) };
        if (entry.query.access_type === 'offline' && !mock.noRefreshToken) {
          body.refresh_token = token('refresh');
          refreshTokens.set(body.refresh_token, claims.sub);
        }
        json(body);
      });
      return;
    }
    if (url.pathname === '/revoke' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const t = new URLSearchParams(raw).get('token');
        mock.revoked.push(t);
        const sub = refreshTokens.get(t) || accessTokens.get(t);
        if (sub) mock.revokeAll(sub);
        res.writeHead(200); res.end();
      });
      return;
    }
    if (url.pathname.startsWith('/tasks/v1/')) return tasksApi(req, res, url);
    if (url.pathname === '/certs') {
      mock.jwksCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    res.writeHead(404); res.end();
  });
  // Just enough of https://tasks.googleapis.com/tasks/v1 for src/tasks.js.
  function tasksApi(req, res, url) {
    mock.tasksCalls++;
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    const sub = accessTokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!sub) return send(401, { error: { code: 401, message: 'Invalid Credentials' } });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const lists = mock.tasksOf(sub);
      const p = url.pathname.slice('/tasks/v1'.length).split('/').map(decodeURIComponent);
      if (req.method === 'GET' && p.join('/') === '/users/@me/lists') return send(200, { items: lists.map(({ id, title }) => ({ id, title })) });
      if (p[1] !== 'lists' || p[3] !== 'tasks') return send(404, {});
      const list = p[2] === '@default' ? lists[0] : lists.find((l) => l.id === p[2]);
      if (!list) return send(404, {});
      if (req.method === 'GET' && p.length === 4) {
        const all = url.searchParams.get('showCompleted') === 'false' ? list.items.filter((t) => t.status !== 'completed') : list.items;
        return send(200, { items: all });
      }
      if (req.method === 'POST' && p.length === 4) return send(200, mock.addTask(sub, body, list.id));
      const task = list.items.find((t) => t.id === p[4]);
      if (!task) return send(404, {});
      if (req.method === 'PATCH') { Object.assign(task, body); if (task.completed === null) delete task.completed; return send(200, task); }
      return send(404, {});
    });
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return mock;
}

module.exports = { startMockGoogle };
