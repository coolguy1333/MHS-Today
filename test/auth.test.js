'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, closeAll, user } = require('./helpers');
const { startMockGoogle } = require('./mock-google');

let mock;
test.before(async () => { mock = await startMockGoogle(); });
test.after(async () => { await mock.close(); });
test.beforeEach(() => { mock.claimOverrides = {}; mock.denyNext = false; });
test.afterEach(closeAll);

test('sign-in creates an account, sets a hardened cookie and lands on the page', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  const res = await c.signIn(mock, user(1, { given_name: 'Ana', family_name: 'Lopez' }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/index.html');
  const cookie = res.headers.getSetCookie().find((x) => x.startsWith('mhs_sid='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Secure/); // plain-http test server
  const me = await c.me();
  assert.equal(me.name, 'Ana L.'); // first name + last initial, not the full name
  assert.equal(me.admin, false);
  assert.match(me.friendCode, /^[A-HJKMNP-Z2-9]{10}$/);
  assert.ok(ctx.logs.some((l) => /Signed in: user [0-9a-f]{16} \(new account\)/.test(l)));
  assert.ok(!ctx.logs.join('\n').includes('user1@school.test'), 'emails are not logged');
  await ctx.close();
});

test('the authorization request uses PKCE, state and nonce', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  const start = await c.raw('GET', '/auth/google');
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin, mock.origin);
  for (const k of ['state', 'nonce', 'code_challenge']) assert.ok((loc.searchParams.get(k) || '').length >= 20, k);
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('redirect_uri'), `${ctx.base}/auth/google/callback`);
  assert.equal(loc.searchParams.get('client_id'), 'test-client');
  const pending = start.headers.getSetCookie().find((x) => x.startsWith('mhs_login='));
  assert.match(pending, /HttpOnly/); assert.match(pending, /Max-Age=600/);
  await ctx.close();
});

test('post-sign-in destination is limited to our own pages', async () => {
  const ctx = await startApp({ mock });
  const ok = await ctx.client().signIn(mock, user(1), 'friends.html?code=ABCDEFGHJK');
  assert.equal(ok.headers.get('location'), '/friends.html?code=ABCDEFGHJK');
  for (const evil of ['//evil.test', 'https://evil.test/x', 'javascript:alert(1)', '/\\evil.test', 'x.html/../../y', 'index.html?<script>', '../index.html']) {
    const r = await ctx.client().signIn(mock, user(1), evil);
    assert.equal(r.headers.get('location'), '/index.html', evil);
  }
  await ctx.close();
});

test('session tokens are stored hashed, never in the clear', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  await c.signIn(mock, user(1));
  const token = decodeURIComponent(c.jar.get('mhs_sid'));
  ctx.app.db.flush();
  const file = fs.readFileSync(path.join(ctx.dataDir, 'db.json'), 'utf8');
  assert.ok(!file.includes(token));
  assert.ok(Object.keys(JSON.parse(file).sessions).every((k) => /^[0-9a-f]{64}$/.test(k)));
  await ctx.close();
});

test('callback without the matching browser cookie is refused (login CSRF)', async () => {
  const ctx = await startApp({ mock });
  // The attacker starts a sign-in in their own browser and captures the callback URL...
  const attacker = ctx.client();
  const start = await attacker.raw('GET', '/auth/google');
  const toGoogle = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(toGoogle.headers.get('location'));
  // ...then tricks the victim's browser (no pending-login cookie) into loading it.
  const victim = ctx.client();
  const r = await victim.raw('GET', cb.pathname + cb.search);
  assert.equal(r.headers.get('location'), '/login.html?error=state');
  assert.equal(await victim.me(), null);
  // a different browser's state value doesn't work either
  const other = ctx.client();
  await other.raw('GET', '/auth/google');
  const r2 = await other.raw('GET', cb.pathname + cb.search);
  assert.equal(r2.headers.get('location'), '/login.html?error=state');
  await ctx.close();
});

test('a forged or altered pending-login cookie is ignored', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  const start = await c.raw('GET', '/auth/google');
  const toGoogle = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(toGoogle.headers.get('location'));
  const [body] = decodeURIComponent(c.jar.get('mhs_login')).split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), next: '/x' })).toString('base64url');
  c.jar.set('mhs_login', encodeURIComponent(`${forged}.AAAA`));
  const r = await c.raw('GET', cb.pathname + cb.search);
  assert.equal(r.headers.get('location'), '/login.html?error=state');
  c.jar.set('mhs_login', 'garbage%E0%A4%A'); // malformed percent-encoding must not crash anything
  assert.equal((await c.raw('GET', cb.pathname + cb.search)).status, 302);
  await ctx.close();
});

test('an expired pending login is refused', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  const start = await c.raw('GET', '/auth/google');
  const toGoogle = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(toGoogle.headers.get('location'));
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60e3;
  try {
    const r = await c.raw('GET', cb.pathname + cb.search);
    assert.equal(r.headers.get('location'), '/login.html?error=state');
  } finally { Date.now = realNow; }
  await ctx.close();
});

test('a callback can be used once', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  const start = await c.raw('GET', '/auth/google');
  const toGoogle = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(toGoogle.headers.get('location'));
  const pendingCookie = c.jar.get('mhs_login');
  assert.equal((await c.raw('GET', cb.pathname + cb.search)).headers.get('location'), '/index.html');
  c.jar.set('mhs_login', pendingCookie); // replay with the same cookie + code
  assert.equal((await c.raw('GET', cb.pathname + cb.search)).headers.get('location'), '/login.html?error=failed');
  await ctx.close();
});

test('cancelling on the Google screen and missing parameters show a friendly error', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  mock.denyNext = true;
  const start = await c.raw('GET', '/auth/google');
  const toGoogle = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(toGoogle.headers.get('location'));
  assert.equal((await c.raw('GET', cb.pathname + cb.search)).headers.get('location'), '/login.html?error=denied');
  assert.equal((await ctx.client().raw('GET', '/auth/google/callback')).headers.get('location'), '/login.html?error=state');
  const s = ctx.client(); await s.raw('GET', '/auth/google');
  const pend = decodeURIComponent(s.jar.get('mhs_login'));
  assert.equal((await s.raw('GET', '/auth/google/callback?state=zzz')).headers.get('location'), '/login.html?error=state');
  assert.equal((await s.raw('GET', '/auth/google/callback?error=server_error')).headers.get('location'), '/login.html?error=failed');
  assert.ok(pend);
  await ctx.close();
});

test('tokens that fail validation never create a session', async () => {
  const ctx = await startApp({ mock });
  for (const [override, expected] of [
    [{ aud: 'other-app' }, 'failed'], [{ iss: 'https://evil.test' }, 'failed'], [{ exp: 1 }, 'failed'],
    [{ nonce: 'wrong' }, 'failed'], [{ email_verified: false }, 'unverified'], [{ sub: undefined }, 'failed']
  ]) {
    mock.claimOverrides = override;
    const c = ctx.client();
    const r = await c.signIn(mock, user(9));
    assert.equal(r.headers.get('location'), `/login.html?error=${expected}`, JSON.stringify(override));
    assert.equal(await c.me(), null);
  }
  assert.equal(Object.keys(ctx.app.state.users).length, 0);
  await ctx.close();
});

test('Google outage or bad client secret fails cleanly', async () => {
  const ctx = await startApp({ mock, tweak: (cfg) => { cfg.google.clientSecret = 'wrong'; } });
  // the app's secret no longer matches what the mock expects
  const r = await ctx.client().signIn(mock, user(1));
  assert.equal(r.headers.get('location'), '/login.html?error=failed');
  assert.ok(ctx.logs.some((l) => /Sign-in failed: .*invalid_client/.test(l)));
  assert.ok(!ctx.logs.join('\n').includes('wrong'), 'the client secret is never logged');
  await ctx.close();
  const down = await startApp({ mock, tweak: (cfg) => { cfg.google.tokenUrl = 'http://127.0.0.1:1/token'; } });
  assert.equal((await down.client().signIn(mock, user(1))).headers.get('location'), '/login.html?error=failed');
  await down.close();
});

test('ALLOWED_DOMAINS: only the verified Workspace domain counts', async () => {
  const ctx = await startApp({ mock, env: { ALLOWED_DOMAINS: '@School.test, other.test' } });
  assert.deepEqual(ctx.config.allowedDomains, ['school.test', 'other.test']);
  const a = ctx.client();
  assert.equal((await a.signIn(mock, user(1, { hd: 'school.test' }))).headers.get('location'), '/index.html');
  assert.ok(await a.me());
  const cases = [
    user(2, { hd: 'evil.test' }), // wrong Workspace domain
    user(3, { hd: undefined, email: 'kid@school.test' }), // personal account that merely looks like a school address
    user(4, { hd: undefined, email: 'kid@gmail.com' })
  ];
  for (const id of cases) {
    const c = ctx.client();
    const r = await c.signIn(mock, id);
    assert.equal(r.headers.get('location'), '/login.html?error=domain', id.email);
    assert.equal(await c.me(), null);
  }
  assert.equal(Object.keys(ctx.app.state.users).length, 1);
  assert.ok(ctx.logs.some((l) => /Sign-in blocked: .*evil\.test/.test(l)));
  assert.ok(ctx.logs.some((l) => /Sign-in blocked: .*personal account/.test(l)));
  // the hint sent to Google is only used when exactly one domain is allowed
  const one = await startApp({ mock, env: { ALLOWED_DOMAINS: 'school.test' } });
  await one.client().raw('GET', '/auth/google').then((r) => assert.equal(new URL(r.headers.get('location')).searchParams.get('hd'), 'school.test'));
  await one.close();
  await ctx.close();
});

test('Google sign-in not configured: pages work, sign-in explains itself', async () => {
  const ctx = await startApp({ env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } });
  const c = ctx.client();
  assert.equal((await c.raw('GET', '/auth/google')).headers.get('location'), '/login.html?error=config');
  assert.equal((await c.raw('GET', '/auth/google/callback?code=x&state=y')).headers.get('location'), '/login.html?error=config');
  const me = (await c.get('/api/me')).data;
  assert.equal(me.user, null); assert.equal(me.config.signIn, false);
  assert.equal((await c.get('/api/calendar')).status, 200);
  assert.equal((await c.get('/api/events')).status, 200);
  await ctx.close();
});

test('https deployments get __Host- cookies, Secure, and HSTS', async () => {
  const ctx = await startApp({ mock, env: { PUBLIC_URL: 'https://hub.example.test' } });
  const c = ctx.client();
  const start = await c.raw('GET', '/auth/google');
  assert.ok(start.headers.getSetCookie().some((x) => /^__Host-mhs_login=/.test(x) && /; Secure/.test(x) && /Path=\//.test(x) && !/Domain=/i.test(x)));
  const toGoogle = await fetch(start.headers.get('location'), { redirect: 'manual' });
  assert.match(new URL(start.headers.get('location')).searchParams.get('redirect_uri'), /^https:\/\/hub\.example\.test\/auth\/google\/callback$/);
  const cb = new URL(toGoogle.headers.get('location'));
  const done = await c.raw('GET', cb.pathname + cb.search);
  const sid = done.headers.getSetCookie().find((x) => x.startsWith('__Host-mhs_sid='));
  assert.ok(sid && /; Secure/.test(sid) && /HttpOnly/.test(sid) && !/Domain=/i.test(sid));
  assert.ok(done.headers.get('strict-transport-security'));
  // a plain, unprefixed cookie of the same idea (planted by a sibling site) is not accepted
  const planted = ctx.client();
  planted.jar.set('mhs_sid', 'attacker-token');
  assert.equal(await planted.me(), null);
  await ctx.close();
});

test('signing out kills the session on the server, not just in the browser', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  await c.signIn(mock, user(1));
  const stolen = c.jar.get('mhs_sid');
  assert.ok(await c.me());
  assert.equal((await c.post('/api/logout')).status, 200);
  assert.equal(await c.me(), null);
  const thief = ctx.client(); thief.jar.set('mhs_sid', stolen);
  assert.equal(await thief.me(), null);
  await ctx.close();
});

test('signing in again rotates the session (no fixation)', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  await c.signIn(mock, user(1));
  const first = c.jar.get('mhs_sid');
  await c.signIn(mock, user(1));
  assert.notEqual(c.jar.get('mhs_sid'), first);
  const old = ctx.client(); old.jar.set('mhs_sid', first);
  assert.equal(await old.me(), null);
  assert.ok(await c.me());
  await ctx.close();
});

test('expired sessions stop working; at most 10 sessions per person', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  await c.signIn(mock, user(1));
  for (const s of Object.values(ctx.app.state.sessions)) s.expires = Date.now() - 1;
  assert.equal(await c.me(), null);
  const devices = [];
  for (let i = 0; i < 12; i++) { const d = ctx.client(); await d.signIn(mock, user(1)); devices.push(d); }
  assert.equal(Object.keys(ctx.app.state.sessions).length, 10);
  assert.equal(await devices[0].me(), null);
  assert.ok(await devices[11].me());
  await ctx.close();
});

test('identity follows the Google subject, not the email', async () => {
  const ctx = await startApp({ mock });
  const a = ctx.client();
  await a.signIn(mock, user(1));
  const idA = (await a.me()).id;
  // same person, new email address
  const a2 = ctx.client();
  await a2.signIn(mock, { ...user(1), email: 'renamed@school.test' });
  assert.equal((await a2.me()).id, idA);
  assert.equal(Object.keys(ctx.app.state.users).length, 1);
  // someone else who now holds the old address is a different account
  const b = ctx.client();
  await b.signIn(mock, { ...user(2), email: 'user1@school.test' });
  assert.notEqual((await b.me()).id, idA);
  await ctx.close();
});

test('admin status comes from ADMIN_EMAILS and the verified email only', async () => {
  const ctx = await startApp({ mock, env: { ADMIN_EMAILS: ' Boss@School.test , other@school.test ' } });
  const boss = ctx.client();
  await boss.signIn(mock, user(1, { email: 'BOSS@school.test' }));
  assert.equal((await boss.me()).admin, true);
  const kid = ctx.client();
  await kid.signIn(mock, user(2, { email: 'kid@school.test', name: 'boss@school.test' }));
  assert.equal((await kid.me()).admin, false);
  // an unverified address can never become admin
  mock.claimOverrides = { email_verified: false };
  const fake = ctx.client();
  assert.equal((await fake.signIn(mock, user(3, { email: 'other@school.test' }))).headers.get('location'), '/login.html?error=unverified');
  assert.equal(await fake.me(), null);
  await ctx.close();
});

test('no ADMIN_EMAILS means nobody is an admin', async () => {
  const ctx = await startApp({ mock, env: { ADMIN_EMAILS: '' } });
  const c = ctx.client();
  await c.signIn(mock, user(1));
  assert.equal((await c.me()).admin, false);
  assert.equal((await c.get('/api/admin/status')).status, 403);
  await ctx.close();
});

test('sign-in floods are throttled per address, and the limit is generous', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  let busy = 0;
  for (let i = 0; i < 310; i++) {
    const r = await c.raw('GET', '/auth/google', { headers: { 'x-real-ip': '203.0.113.9' } });
    if (r.headers.get('location') === '/login.html?error=busy') busy++;
  }
  assert.equal(busy, 10);
  // another address is unaffected
  const r = await c.raw('GET', '/auth/google', { headers: { 'x-real-ip': '203.0.113.10' } });
  assert.notEqual(r.headers.get('location'), '/login.html?error=busy');
  await ctx.close();
});

test('the user cap stops runaway sign-ups', async () => {
  const ctx = await startApp({ mock, tweak: (cfg) => { cfg.maxUsers = 2; } });
  await ctx.client().signIn(mock, user(1));
  await ctx.client().signIn(mock, user(2));
  const r = await ctx.client().signIn(mock, user(3));
  assert.equal(r.headers.get('location'), '/login.html?error=full');
  await ctx.client().signIn(mock, user(1)); // existing accounts still get in
  await ctx.close();
});
