'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Starts the real app on a free port with a temp data dir, wired to the mock Google.
async function startApp({ mock, env = {}, tweak } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhs-test-'));
  const port = await freePort();
  const config = loadConfig({
    PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, PUBLIC_URL: `http://127.0.0.1:${port}`, TRUST_PROXY: 'true',
    ADMIN_EMAILS: 'admin@school.test', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', ...env
  });
  if (mock) mock.configure(config);
  if (tweak) tweak(config);
  const logs = [];
  const app = createApp(config, { log: (...a) => logs.push(a.join(' ')) });
  await app.listen();
  let closed = false;
  const ctx = {
    app, config, dataDir, logs,
    base: config.publicUrl,                         // what the app believes its public address is
    local: `http://127.0.0.1:${port}`,              // where it is actually listening
    client: () => new Client(`http://127.0.0.1:${port}`),
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
  running.add(ctx);
  return ctx;
}

// Tests register `test.afterEach(closeAll)` so a failing test can never leave a server running.
const running = new Set();
async function closeAll() {
  for (const ctx of running) await ctx.close();
  running.clear();
}

// A tiny browser: keeps cookies, never follows redirects automatically.
class Client {
  constructor(base) { this.base = base; this.jar = new Map(); }

  async raw(method, p, { body, headers = {}, xhr = true } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (xhr && method !== 'GET' && method !== 'HEAD') h['x-requested-with'] = 'mhs';
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!('content-type' in h)) h['content-type'] = 'application/json';
    }
    const res = await fetch(this.base + p, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      if (/;\s*Max-Age=0/i.test(c)) this.jar.delete(name); else this.jar.set(name, pair.slice(i + 1));
    }
    return res;
  }
  // -> { status, data, headers }
  async call(method, p, body, opts = {}) {
    const res = await this.raw(method, p, { body, ...opts });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers, res };
  }
  get(p, opts) { return this.call('GET', p, undefined, opts); }
  post(p, body = {}, opts) { return this.call('POST', p, body, opts); }
  put(p, body, opts) { return this.call('PUT', p, body, opts); }
  del(p, opts) { return this.call('DELETE', p, undefined, opts); }

  // Runs the full sign-in dance against the mock. Returns the final callback response.
  async signIn(mock, identity, next) {
    if (identity) mock.identity = { sub: 'sub-1', email: 'student@school.test', email_verified: true, given_name: 'Sam', family_name: 'Student', hd: 'school.test', ...identity };
    const start = await this.raw('GET', '/auth/google' + (next ? `?next=${encodeURIComponent(next)}` : ''));
    assert.equal(start.status, 302);
    const toGoogle = await fetch(start.headers.get('location'), { redirect: 'manual' });
    const cb = new URL(toGoogle.headers.get('location'));
    return this.raw('GET', cb.pathname + cb.search);
  }
  async me() { return (await this.get('/api/me')).data.user; }
}

const user = (n, extra = {}) => ({ sub: `sub-${n}`, email: `user${n}@school.test`, given_name: `User${n}`, family_name: 'Test', ...extra });

module.exports = { startApp, closeAll, Client, user, freePort };
