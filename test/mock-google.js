'use strict';
// A stand-in for Google's OAuth/OIDC endpoints, for tests only.
const http = require('node:http');
const crypto = require('node:crypto');

async function startMockGoogle() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); // for "wrong signature" tests
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map();
  let origin = '';

  const mock = {
    clientId: 'test-client', clientSecret: 'test-secret',
    // who "signs in" next; tests replace this
    identity: { sub: 'sub-1', email: 'student@school.test', email_verified: true, given_name: 'Sam', family_name: 'Student', name: 'Sam Student', hd: 'school.test' },
    // tweaks applied to the next id_token (wrong aud, expired, ...)
    claimOverrides: {},
    denyNext: false,
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
    // Point an app config at this mock.
    configure(config) {
      config.google = {
        clientId: mock.clientId, clientSecret: mock.clientSecret,
        authUrl: `${origin}/auth`, tokenUrl: `${origin}/token`, jwksUrl: `${origin}/certs`, issuers: [origin]
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
        const entry = codes.get(f.get('code'));
        const fail = (error) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error })); };
        if (!entry) return fail('invalid_grant');
        codes.delete(f.get('code')); // single use
        if (f.get('client_id') !== mock.clientId || f.get('client_secret') !== mock.clientSecret) return fail('invalid_client');
        if (f.get('redirect_uri') !== entry.redirectUri || f.get('grant_type') !== 'authorization_code') return fail('invalid_grant');
        const challenge = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
        if (entry.method !== 'S256' || challenge !== entry.challenge) return fail('invalid_grant');
        const claims = { ...mock.baseClaims(entry.nonce), ...entry.identity, ...mock.claimOverrides };
        for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'unused', id_token: mock.signToken(claims) }));
      });
      return;
    }
    if (url.pathname === '/certs') {
      mock.jwksCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return mock;
}

module.exports = { startMockGoogle };
