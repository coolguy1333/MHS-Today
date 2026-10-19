'use strict';
// Assignments are each person's own Google Tasks. Someone connects once from the Assignments page
// (Google asks them to allow MHS Hub to see and edit their tasks); the refresh token is kept
// encrypted (src/secretbox.js) and never leaves the server. Pages talk only to this server, which
// calls the Google Tasks API for them, so the site's security policy stays "same origin only".
const SCOPE = 'https://www.googleapis.com/auth/tasks';
const REQUEST_SCOPE = `openid email ${SCOPE}`;
const MAX_LISTS = 10;
const ID = /^[A-Za-z0-9_@-]{1,200}$/; // Google list and task ids

class ConnectError extends Error {
  // code: 'scope' (the box to allow Tasks was unticked) | 'offline' (no refresh token came back)
  constructor(code) { super(code); this.code = code; }
}

module.exports = function tasks(app) {
  const { route, state, db, log, config, HttpError, bad, cleanText, limiter, cal, google, secrets, fetchFn } = app;
  const base = config.google.tasksApi;
  const cache = new Map(); // user id -> { token, exp } (access tokens, memory only)
  const connected = (u) => !!(u && u.googleTasks && typeof u.googleTasks.token === 'string');
  const reconnect = () => Object.assign(new HttpError(409, 'Google Tasks was disconnected. Connect it again.'), { reconnect: true });
  const unreachable = () => new HttpError(502, "Couldn't reach Google Tasks. Try again in a minute.");

  function forget(user) {
    delete user.googleTasks;
    cache.delete(user.id);
    db.save();
  }

  // After the Google consent screen: keep the refresh token (encrypted) and the first access token.
  function connect(user, body) {
    if (!String(body.scope || '').split(' ').includes(SCOPE)) throw new ConnectError('scope');
    if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw new ConnectError('offline');
    user.googleTasks = { token: secrets.seal(body.refresh_token), connected: Date.now() };
    if (typeof body.access_token === 'string') cache.set(user.id, { token: body.access_token, exp: Date.now() + (Number(body.expires_in) || 3600) * 1000 - 60e3 });
    log(`Google Tasks connected: user ${user.id}`);
    db.save();
  }

  async function accessToken(user, fresh) {
    const c = cache.get(user.id);
    if (!fresh && c && c.exp > Date.now()) return c.token;
    const refreshToken = secrets.open(user.googleTasks.token);
    if (!refreshToken) { forget(user); throw reconnect(); } // the key file changed
    try {
      const r = await google.refresh(refreshToken);
      cache.set(user.id, { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60e3 });
      return r.access_token;
    } catch (e) {
      if (e.code === 'revoked') { log(`Google Tasks access was revoked: user ${user.id}`); forget(user); throw reconnect(); }
      log(`Google Tasks token refresh failed: ${e.message}`);
      throw unreachable();
    }
  }

  // One Tasks API call, retried once with a fresh token if Google says the token is no good.
  async function gapi(user, method, p, body) {
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(user, attempt > 0);
      let res;
      try {
        res = await (fetchFn || fetch)(base + p, {
          method, redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined
        });
      } catch { throw unreachable(); }
      if (res.status === 401 && attempt === 0) { cache.delete(user.id); continue; }
      if (res.status === 404) throw new HttpError(404, 'That task or list no longer exists');
      if (!res.ok) {
        // 403 usually means the Tasks API isn't turned on in the Google Cloud project
        log(`Google Tasks API answered ${res.status} for ${method} ${p.split('?')[0].replace(/\/[A-Za-z0-9_@-]{12,}/g, '/…')}`);
        throw unreachable();
      }
      return res.status === 204 ? null : res.json().catch(() => null);
    }
  }

  const dueOf = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);
  const listView = (l) => ({ id: l.id, title: cleanText(l.title, 100) || 'My Tasks' });
  function taskView(t, list) {
    return {
      id: t.id, listId: list.id, list: list.title, title: cleanText(t.title, 300) || '(no title)',
      notes: typeof t.notes === 'string' ? cleanText(t.notes, 1000) : '', due: dueOf(t.due),
      link: typeof t.webViewLink === 'string' && /^https:\/\/tasks\.google\.com\//.test(t.webViewLink) ? t.webViewLink : null
    };
  }
  // Everything not done yet, from up to 10 lists, soonest first (no due date last).
  async function openTasks(user) {
    const lists = (((await gapi(user, 'GET', '/users/@me/lists?maxResults=20')) || {}).items || [])
      .filter((l) => l && typeof l.id === 'string' && ID.test(l.id)).slice(0, MAX_LISTS).map(listView);
    const per = await Promise.all(lists.map(async (l) => {
      const r = await gapi(user, 'GET', `/lists/${encodeURIComponent(l.id)}/tasks?showCompleted=false&showHidden=false&maxResults=100`);
      return ((r && r.items) || []).filter((t) => t && typeof t.id === 'string' && ID.test(t.id) && t.status !== 'completed' && !t.deleted).map((t) => taskView(t, l));
    }));
    const tasks = per.flat().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title));
    return { lists, tasks };
  }

  const ready = (user) => {
    if (!google) throw new HttpError(503, "Google sign-in isn't set up on this site");
    if (!connected(user)) throw reconnect();
    if (!limiter.hit(`tasks:${user.id}`, 60, 60e3)) throw new HttpError(429, 'Slow down a little');
  };

  route('GET', '/api/tasks', { auth: 'user' }, async ({ user }) => {
    if (!google) return { available: false, connected: false };
    if (!connected(user)) return { available: true, connected: false };
    ready(user);
    return { available: true, connected: true, ...(await openTasks(user)) };
  });
  route('POST', '/api/tasks', { auth: 'user' }, async ({ user, body }) => {
    ready(user);
    const title = cleanText(body.title, 300);
    if (!title) throw bad('Give it a title');
    const due = body.due === undefined || body.due === null || body.due === '' ? null : body.due;
    if (due !== null && cal.parseDate(due) === null) throw bad('Pick a valid due date');
    const listId = body.listId ? String(body.listId) : '@default';
    if (!ID.test(listId)) throw bad('Pick one of your task lists');
    const t = await gapi(user, 'POST', `/lists/${encodeURIComponent(listId)}/tasks`, {
      title, notes: cleanText(body.notes, 1000) || undefined, due: due ? `${due}T00:00:00.000Z` : undefined
    });
    return taskView(t || {}, { id: listId, title: '' });
  });
  route('PUT', '/api/tasks/:list/:task', { auth: 'user' }, async ({ user, params, body }) => {
    ready(user);
    if (!ID.test(params.list) || !ID.test(params.task)) throw bad('Bad request');
    if (typeof body.done !== 'boolean') throw bad('Invalid request');
    await gapi(user, 'PATCH', `/lists/${encodeURIComponent(params.list)}/tasks/${encodeURIComponent(params.task)}`,
      body.done ? { status: 'completed' } : { status: 'needsAction', completed: null });
    return { ok: true };
  });
  route('DELETE', '/api/tasks/connection', { auth: 'user' }, async ({ user }) => {
    if (connected(user)) {
      const token = secrets.open(user.googleTasks.token);
      forget(user);
      if (token && google) await google.revoke(token);
      log(`Google Tasks disconnected: user ${user.id}`);
    }
    return { ok: true };
  });

  return {
    SCOPE, REQUEST_SCOPE, ConnectError, connect, connected,
    // for reminders: open tasks due on `date`, or [] if anything goes wrong
    async tasksDueOn(user, date) {
      if (!google || !connected(user)) return [];
      try { return (await openTasks(user)).tasks.filter((t) => t.due === date); } catch { return []; }
    },
    status: () => ({ tasksConnected: Object.values(state.users).filter(connected).length }),
    // Tokens are never in backups. A restore on the same server keeps connections (src/app.js);
    // anywhere else, people connect again.
    exportData: () => ({}),
    importData() { cache.clear(); },
    maintain() {},
    forgetUser(id, user) {
      cache.delete(id);
      const token = user && connected(user) ? secrets.open(user.googleTasks.token) : null;
      if (token && google) google.revoke(token);
    }
  };
};
