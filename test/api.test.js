'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cal = require('../public/js/calendar.js');
const { startApp, closeAll, user } = require('./helpers');
const { startMockGoogle } = require('./mock-google');

let mock;
test.before(async () => { mock = await startMockGoogle(); });
test.after(async () => { await mock.close(); });
test.beforeEach(() => { mock.claimOverrides = {}; });
test.afterEach(closeAll);

async function as(ctx, n, extra) {
  const c = ctx.client();
  assert.equal((await c.signIn(mock, user(n, extra))).status, 302);
  return c;
}
const soon = (days = 3) => cal.addDays(cal.schoolNow('America/Chicago').date, days);

// ---------------------------------------------------------------- plumbing

test('security headers are on every kind of response', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  for (const [p, opts] of [['/', {}], ['/api/health', {}], ['/api/nope', {}], ['/nope.png', {}], ['/auth/google', {}]]) {
    const r = await c.raw('GET', p, opts);
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, p);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);        // no 'unsafe-inline' / 'unsafe-eval'
    assert.match(csp, /style-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /manifest-src 'self'/);   // the installable app's manifest must be allowed
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /base-uri 'none'/);
    assert.doesNotMatch(csp, /unsafe/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
    assert.equal(r.headers.get('referrer-policy'), 'same-origin', p);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow', p);
    assert.equal(r.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
    await r.arrayBuffer();
  }
  assert.equal((await c.raw('GET', '/api/health')).headers.get('cache-control'), 'no-store');
});

test('static files: clean URLs, caching, no path traversal, no dotfiles or source', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  const home = await c.raw('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /MHS Hub/);
  assert.equal((await c.raw('GET', '/events')).status, 200);             // /events -> events.html
  const robots = await c.raw('GET', '/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  const rules = await robots.text();
  assert.match(rules, /^Disallow: \/$/m);
  // Google Calendar's fetcher obeys robots.txt: without this, subscribed calendars stay empty
  assert.match(rules, /^Allow: \/cal\/$/m);
  assert.equal((await c.raw('GET', '/index.html')).status, 200);
  const css = await c.raw('GET', '/css/style.css');
  const etag = css.headers.get('etag');
  assert.ok(etag); assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal((await c.raw('GET', '/css/style.css', { headers: { 'if-none-match': etag } })).status, 304);
  assert.equal((await c.raw('HEAD', '/css/style.css')).status, 200);
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/css/../../server.js', '/src/app.js', '/server.js', '/test/helpers.js',
    '/data/db.json', '/db.json', '/.git/config', '/css/', '/css', '/js/%00.js', '/%5c..%5cserver.js', '/package.json', '/Dockerfile']) {
    const r = await c.raw('GET', p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    const body = await r.text();
    assert.ok(!body.includes('createServer') && !body.includes('db.json'), p);
  }
  assert.equal((await c.raw('GET', '/%E0%A4%A')).status, 400);          // malformed escape is a 400, not a crash
  assert.equal((await c.raw('POST', '/index.html', { xhr: false })).status, 405);
  const missing = await c.raw('GET', '/nope', { headers: { accept: 'text/html' } });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /<html/i);                          // friendly page for browsers
  assert.equal((await c.raw('GET', '/nope.png', { headers: { accept: 'image/png' } })).status, 404);
});

test('state-changing requests must look like they come from our pages', async () => {
  const ctx = await startApp({ mock });
  const c = await as(ctx, 1);
  const body = { name: 'Renamed' };
  assert.equal((await c.put('/api/me', body, { xhr: false })).status, 403);                                   // no custom header
  assert.equal((await c.put('/api/me', body, { headers: { origin: 'https://evil.test' } })).status, 403);     // foreign origin
  assert.equal((await c.put('/api/me', body, { headers: { origin: 'null' } })).status, 403);                  // sandboxed iframe
  assert.equal((await c.put('/api/me', body, { headers: { origin: 'not a url' } })).status, 403);
  assert.equal((await c.put('/api/me', body, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  // a sibling subdomain (same-site, different origin) is blocked by the Origin check
  assert.equal((await c.put('/api/me', body, { headers: { origin: 'https://evil.example.test', 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await c.del('/api/events/0123456789abcdef', { xhr: false })).status, 403);
  assert.equal((await c.post('/api/logout', {}, { xhr: false })).status, 403);
  assert.equal((await c.me()).name, 'User1 T.');                                                                // nothing changed
  const origin = `http://127.0.0.1:${new URL(ctx.base).port}`;
  assert.equal((await c.put('/api/me', body, { headers: { origin, 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await c.me()).name, 'Renamed');
});

test('bad bodies get clean errors, never a crash', async () => {
  const ctx = await startApp({ mock });
  const c = await as(ctx, 1);
  assert.equal((await c.put('/api/me', '{oops')).status, 400);
  for (const weird of ['null', '[]', '123', '"str"', 'true']) assert.equal((await c.put('/api/classes', weird)).status, 400, weird);
  assert.equal((await c.put('/api/me', 'x=1', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await c.put('/api/me', 'name=x', { headers: { 'content-type': 'text/plain' } })).status, 415);
  const big = await c.put('/api/me', JSON.stringify({ name: 'x'.repeat(200 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal((await c.get('/api/me')).status, 200);                    // server still fine
  assert.equal((await c.get('/api/nope')).status, 404);
  assert.equal((await c.post('/api/health')).status, 405);
  assert.equal((await c.get('/api/events/%E0%A4%A')).status, 405);      // known path, wrong method
  assert.equal((await c.del('/api/events/%E0%A4%A')).status, 400);
  assert.equal((await ctx.client().get('/api/classes', { headers: { cookie: 'mhs_sid=%E0%A4%A' } })).status, 401); // malformed cookie = signed out
});

test('things that look like object internals are just unknown ids', async () => {
  const ctx = await startApp({ mock });
  const c = await as(ctx, 1);
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal((await c.post(`/api/friends/${id}/accept`)).status, 404, id);
    assert.equal((await c.del(`/api/friends/${id}`)).status, 200, id);
    assert.equal((await c.del(`/api/events/${id}`)).status, 404, id);
  }
  const r = await c.put('/api/classes', { __proto__: { polluted: 1 }, constructor: { name: 'x' }, yellow: { name: 'Math', __proto__: { x: 1 } } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data), ['yellow']);
  assert.equal({}.polluted, undefined);
  const raw = '{"red":{"name":"Art"},"__proto__":{"polluted":true}}';
  assert.equal((await c.put('/api/classes', raw)).status, 200);
  assert.equal({}.polluted, undefined);
});

test('anonymous visitors can read public data and nothing private', async () => {
  const ctx = await startApp({ mock });
  const anon = ctx.client();
  for (const p of ['/api/health', '/api/me', '/api/calendar', '/api/events']) assert.equal((await anon.get(p)).status, 200, p);
  for (const p of ['/api/classes', '/api/friends', '/api/admin/status', '/api/admin/users', '/api/admin/backup']) assert.equal((await anon.get(p)).status, 401, p);
  for (const [m, p] of [['PUT', '/api/classes'], ['POST', '/api/events'], ['PUT', '/api/me'], ['DELETE', '/api/me'], ['POST', '/api/friends/request'],
    ['PUT', '/api/admin/calendar'], ['POST', '/api/admin/restore']]) {
    assert.equal((await anon.call(m, p, {})).status, 401, `${m} ${p}`);
  }
});

test('writes are rate limited per person', async () => {
  const ctx = await startApp({ mock });
  const c = await as(ctx, 1);
  let limited = 0;
  for (let i = 0; i < 130; i++) if ((await c.put('/api/classes', {})).status === 429) limited++;
  assert.equal(limited, 10);
  const other = await as(ctx, 2);
  assert.equal((await other.put('/api/classes', {})).status, 200);
});

// ---------------------------------------------------------------- classes & profile

test('classes: one per color block, validated, trimmed, blank name clears, lunch only on Hour 4 blocks', async () => {
  const ctx = await startApp({ mock });
  const c = await as(ctx, 1);
  assert.deepEqual((await c.get('/api/classes')).data, {});
  const r = await c.put('/api/classes', {
    yellow: { name: '  Algebra  II ', teacher: 'Mr.   Smith', room: '204', color: '#FF0000', lunch: 'A' },
    pink: { name: '<img src=x onerror=alert(1)>', teacher: 'a\u0000b\nc' },
    red: { name: '   ' },
    green: { name: 'Biology', lunch: 'B' }, orange: { name: 'Gym', lunch: 'D' },
    Yellow: { name: 'caps' }, 'blue ': { name: 'sneaky' }, black: { name: 'no such block' }, E_1: { name: 'Day E' }, A_7: { name: 'Hour seven' },
    purple: 'not an object', blue: null,
    silver: { name: 'x'.repeat(200), room: 'r'.repeat(100) }
  });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ['green', 'orange', 'pink', 'silver', 'yellow']);
  assert.deepEqual(r.data.yellow, { name: 'Algebra II', teacher: 'Mr. Smith', room: '204' });
  assert.deepEqual(r.data.green, { name: 'Biology', teacher: '', room: '', lunch: 'B' });
  assert.equal(r.data.orange.lunch, undefined, 'only A, B or C');
  assert.equal(r.data.pink.name, '<img src=x onerror=alert(1)>'); // stored as plain text; the pages never parse it as HTML
  assert.equal(r.data.pink.teacher, 'a b c');
  assert.equal(Array.from(r.data.silver.name).length, 60);
  assert.equal(r.data.silver.room.length, 20);
  assert.deepEqual((await c.get('/api/classes')).data, r.data);
  assert.deepEqual((await c.put('/api/classes', {})).data, {});      // clearing everything works
  assert.deepEqual((await (await as(ctx, 2)).get('/api/classes')).data, {}); // and they're private per person
});

test('classes: day-and-hour schedules from the first release move to their color block', async () => {
  const ctx = await startApp({ mock });
  const c = await as(ctx, 1);
  const r = await c.put('/api/classes', {
    A_1: { name: 'Math', color: '#123456' }, C_1: { name: 'Also yellow' }, B_1: { name: 'Bio' }, A_4: { name: 'Gym', lunch: 'C' },
    red: { name: 'Choir' }, A_2: { name: 'Old red' }
  });
  assert.deepEqual(r.data, {
    red: { name: 'Choir', teacher: '', room: '' }, yellow: { name: 'Math', teacher: '', room: '' },
    green: { name: 'Gym', teacher: '', room: '', lunch: 'C' }, blue: { name: 'Bio', teacher: '', room: '' }
  });
});

test('classes: saved schedules in the old format are converted at startup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhs-test-'));
  const id = '00000000000000aa';
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    version: 2, sessions: {}, events: [], calendar: cal.emptyCalendar(),
    users: {
      [id]: {
        id, sub: 'sub-1', email: 'user1@school.test', name: 'Old', created: 1, lastLogin: 1, friends: [], friendCode: 'ABCDEFGHJK', shareSchedule: true,
        classes: { A_1: { name: 'Math', teacher: 'T', room: '1', color: '#112233' }, D_4: { name: 'Gym' } }
      }
    }
  }));
  const ctx = await startApp({ mock, tweak: (cfg) => { cfg.dataDir = dir; } });
  assert.deepEqual(ctx.app.state.users[id].classes, { yellow: { name: 'Math', teacher: 'T', room: '1' }, orange: { name: 'Gym', teacher: '', room: '' } });
  assert.ok(ctx.logs.some((l) => /Converted 1 saved schedule to color blocks/.test(l)));
});

test('profile: display name and sharing toggle are validated', async () => {
  const ctx = await startApp({ mock });
  const c = await as(ctx, 1);
  assert.equal((await c.put('/api/me', { name: '  Sam   the  Man ' })).data.name, 'Sam the Man');
  assert.equal((await c.put('/api/me', { name: '   ' })).status, 400);
  assert.equal((await c.put('/api/me', { name: 123 })).status, 400);
  assert.equal((await c.put('/api/me', { name: 'x'.repeat(100) })).data.name.length, 40);
  assert.equal((await c.put('/api/me', { name: 'Evil‮name​' })).data.name, 'Evil name');   // bidi override / zero-width stripped
  assert.equal((await c.put('/api/me', { shareSchedule: 'no' })).status, 400);
  assert.equal((await c.put('/api/me', { shareSchedule: false })).data.shareSchedule, false);
  assert.equal((await c.me()).shareSchedule, false);
  // things the user must not be able to set
  await c.put('/api/me', { admin: true, email: 'admin@school.test', id: 'x', friendCode: 'AAAAAAAAAA' });
  const me = await c.me();
  assert.equal(me.admin, false); assert.notEqual(me.friendCode, 'AAAAAAAAAA');
});

// ---------------------------------------------------------------- events

test('events: add, list sorted, validate, delete own only', async () => {
  const ctx = await startApp({ mock });
  const a = await as(ctx, 1);
  const b = await as(ctx, 2);
  const late = await a.post('/api/events', { title: ' Pep   rally ', date: soon(5), time: '14:30', description: 'Gym' });
  assert.equal(late.status, 200);
  const early = await b.post('/api/events', { title: 'Bake sale', date: soon(2) });
  assert.equal(early.status, 200);
  const all = (await a.get('/api/events')).data;
  assert.deepEqual(all.map((e) => e.title), ['Bake sale', 'Pep rally']);
  assert.equal(all[1].time, '14:30');
  assert.deepEqual(all.map((e) => e.mine), [false, true]);
  assert.equal(all[0].by, 'User2 T.');
  // the author's name is only visible to signed-in people
  const pub = (await ctx.client().get('/api/events')).data;
  assert.ok(pub.every((e) => e.by === undefined && e.mine === false));
  assert.equal((await b.del(`/api/events/${late.data.id}`)).status, 403);
  assert.equal((await a.del(`/api/events/${late.data.id}`)).status, 200);
  assert.equal((await a.del(`/api/events/${late.data.id}`)).status, 404);
  assert.equal((await ctx.client().del(`/api/events/${early.data.id}`)).status, 401);
});

test('events: bad input is rejected', async () => {
  const ctx = await startApp({ mock });
  const c = await as(ctx, 1);
  const bad = [
    {}, { title: '', date: soon() }, { title: '   ', date: soon() }, { title: 'x' }, { title: 'x', date: '2026-02-31' },
    { title: 'x', date: 'tomorrow' }, { title: 'x', date: soon(), time: '25:00' }, { title: 'x', date: soon(), time: '9:00' },
    { title: 'x', date: soon(), time: '12:60' }, { title: 'x', date: soon(-30) }, { title: 'x', date: soon(366 * 4) },
    { title: 'x', date: '9999-12-31' }, { title: 'x', date: 20260101 }, { title: ['x'], date: soon() }
  ];
  for (const b of bad) assert.equal((await c.post('/api/events', b)).status, 400, JSON.stringify(b));
  const ok = await c.post('/api/events', { title: '<b>bold</b> & "quotes"', date: soon(), description: 'x'.repeat(900), time: '' });
  assert.equal(ok.status, 200);
  const [ev] = (await c.get('/api/events')).data;
  assert.equal(ev.title, '<b>bold</b> & "quotes"');            // plain text, escaped when shown
  assert.equal(ev.description.length, 500);
  assert.equal((await c.post('/api/events', { title: 'Today', date: soon(0) })).status, 200);
  assert.equal((await c.post('/api/events', { title: 'Yesterday', date: soon(-1) })).status, 200);
});

test('events: 10 a day per student, admins exempt; posting can be limited to admins', async () => {
  const ctx = await startApp({ mock });
  const c = await as(ctx, 1);
  for (let i = 0; i < 10; i++) assert.equal((await c.post('/api/events', { title: `e${i}`, date: soon() })).status, 200);
  assert.equal((await c.post('/api/events', { title: 'one too many', date: soon() })).status, 429);
  assert.equal((await c.post('/api/events', { title: '', date: soon() })).status, 400, 'invalid requests do not use up the allowance');
  const admin = await as(ctx, 7, { email: 'admin@school.test' });
  for (let i = 0; i < 15; i++) assert.equal((await admin.post('/api/events', { title: `a${i}`, date: soon() })).status, 200);
  const strict = await startApp({ mock, env: { EVENT_POSTING: 'admins' } });
  const kid = await as(strict, 1);
  const boss = await as(strict, 7, { email: 'admin@school.test' });
  assert.equal((await kid.post('/api/events', { title: 'x', date: soon() })).status, 403);
  assert.equal((await boss.post('/api/events', { title: 'x', date: soon() })).status, 200);
  assert.equal((await kid.get('/api/me')).data.config.eventPosting, 'admins');
});

test('events: by default only admins and verified people can post, and admins verify people', async () => {
  const ctx = await startApp({ mock, env: { EVENT_POSTING: undefined } });
  const kid = await as(ctx, 1);
  const other = await as(ctx, 2);
  const boss = await as(ctx, 7, { email: 'admin@school.test' });
  assert.equal((await kid.get('/api/me')).data.config.eventPosting, 'verified');
  let me = await kid.me();
  assert.equal(me.verified, false); assert.equal(me.canPostEvents, false);
  const denied = await kid.post('/api/events', { title: 'x', date: soon() });
  assert.equal(denied.status, 403); assert.match(denied.data.error, /verified/);
  assert.equal((await boss.me()).canPostEvents, true);
  assert.equal((await boss.post('/api/events', { title: 'From admin', date: soon() })).status, 200);

  // students can't verify themselves or anyone else
  assert.equal((await kid.put('/api/me', { verified: true })).status, 200);
  assert.equal((await kid.me()).verified, false);
  assert.equal((await other.put(`/api/admin/users/${me.id}`, { verified: true })).status, 403);

  assert.equal((await boss.put(`/api/admin/users/${me.id}`, { verified: 'yes' })).status, 400);
  assert.equal((await boss.put('/api/admin/users/0123456789abcdef', { verified: true })).status, 404);
  assert.equal((await boss.put(`/api/admin/users/${me.id}`, { verified: true })).status, 200);
  me = await kid.me();
  assert.equal(me.verified, true); assert.equal(me.canPostEvents, true);
  assert.equal((await kid.post('/api/events', { title: 'Club meeting', date: soon() })).status, 200);
  assert.equal((await other.post('/api/events', { title: 'x', date: soon() })).status, 403);
  assert.equal((await boss.get('/api/admin/users')).data.find((u) => u.id === me.id).verified, true);

  assert.equal((await boss.put(`/api/admin/users/${me.id}`, { verified: false })).status, 200);
  assert.equal((await kid.post('/api/events', { title: 'x', date: soon() })).status, 403);
  assert.equal((await kid.get('/api/events')).data.length, 2, 'unverifying keeps events already posted');
});

test('events: admins can delete anyone\'s, the board has a size cap', async () => {
  const ctx = await startApp({ mock, tweak: (cfg) => { cfg.maxEvents = 3; } });
  const kid = await as(ctx, 1);
  const admin = await as(ctx, 7, { email: 'admin@school.test' });
  const made = [];
  for (let i = 0; i < 3; i++) made.push((await kid.post('/api/events', { title: `e${i}`, date: soon() })).data.id);
  assert.equal((await kid.post('/api/events', { title: 'full', date: soon() })).status, 400);
  assert.equal((await admin.get('/api/events')).data.every((e) => e.mine), true);
  assert.equal((await admin.del(`/api/events/${made[0]}`)).status, 200);
  assert.equal((await kid.post('/api/events', { title: 'room again', date: soon() })).status, 200);
});

// ---------------------------------------------------------------- friends

test('friends: request by code, confirm, see schedules, unfriend', async () => {
  const ctx = await startApp({ mock });
  const a = await as(ctx, 1, { given_name: 'Ann' });
  const b = await as(ctx, 2, { given_name: 'Ben' });
  await a.put('/api/classes', { yellow: { name: 'Math', room: '1' } });
  await b.put('/api/classes', { yellow: { name: 'Math', room: '1' }, red: { name: 'Art' } });
  const codeB = (await b.me()).friendCode;

  // the code can be typed sloppily; looking it up only reveals a first name
  const look = await a.post('/api/friends/lookup', { code: `  ${codeB.slice(0, 5).toLowerCase()}-${codeB.slice(5)} ` });
  assert.deepEqual(look.data, { name: 'Ben T.' });
  assert.equal((await a.post('/api/friends/lookup', { code: 'AAAAAAAAAA' })).status, 404);
  assert.equal((await a.post('/api/friends/lookup', { code: 'nope' })).status, 404);
  assert.equal((await a.post('/api/friends/lookup', {})).status, 404);
  assert.equal((await a.post('/api/friends/lookup', { code: (await a.me()).friendCode })).status, 400);

  // nothing is shared until Ben says yes
  assert.deepEqual((await a.post('/api/friends/request', { code: codeB })).data, { status: 'requested', name: 'Ben T.' });
  assert.deepEqual((await a.post('/api/friends/request', { code: codeB })).data.status, 'requested'); // idempotent
  let fa = (await a.get('/api/friends')).data;
  assert.equal(fa.friends.length, 0); assert.equal(fa.outgoing.length, 1);
  let fb = (await b.get('/api/friends')).data;
  assert.deepEqual(fb.incoming.map((x) => x.name), ['Ann T.']);
  assert.equal(fb.friends.length, 0);
  const annId = fb.incoming[0].id;
  assert.equal((await b.post('/api/friends/0123456789abcdef/accept')).status, 404);
  assert.equal((await a.post(`/api/friends/${(await b.me()).id}/accept`)).status, 404, 'you cannot accept a request you sent');
  assert.equal((await b.post(`/api/friends/${annId}/accept`)).status, 200);

  fa = (await a.get('/api/friends')).data;
  fb = (await b.get('/api/friends')).data;
  assert.equal(fa.friends[0].name, 'Ben T.');
  assert.equal(fa.friends[0].classes.red.name, 'Art');
  assert.equal(fb.friends[0].classes.yellow.name, 'Math');
  assert.equal(fa.outgoing.length + fa.incoming.length + fb.outgoing.length + fb.incoming.length, 0);
  assert.equal(JSON.stringify(fa).includes('friendCode'), false);
  assert.equal(JSON.stringify(fa).includes('@school.test'), false, 'friends never see email addresses');

  // privacy switch hides the schedule but not the friendship
  await b.put('/api/me', { shareSchedule: false });
  fa = (await a.get('/api/friends')).data;
  assert.equal(fa.friends[0].name, 'Ben T.'); assert.equal(fa.friends[0].classes, null);
  await b.put('/api/me', { shareSchedule: true });

  // unfriend from either side removes both directions
  assert.equal((await a.del(`/api/friends/${fa.friends[0].id}`)).status, 200); // Ann removes Ben
  assert.equal((await a.get('/api/friends')).data.friends.length, 0);
  assert.equal((await b.get('/api/friends')).data.friends.length, 0);
  assert.equal((await b.get('/api/friends')).data.incoming.length, 0);
});

test('friends: if both sides ask, they become friends at once; decline and cancel work', async () => {
  const ctx = await startApp({ mock });
  const [a, b, c] = [await as(ctx, 1), await as(ctx, 2), await as(ctx, 3)];
  const [ma, mb, mc] = [await a.me(), await b.me(), await c.me()];
  await a.post('/api/friends/request', { code: mb.friendCode });
  assert.equal((await b.post('/api/friends/request', { code: ma.friendCode })).data.status, 'friends');
  assert.equal((await a.get('/api/friends')).data.friends.length, 1);
  // decline
  await c.post('/api/friends/request', { code: ma.friendCode });
  assert.equal((await a.get('/api/friends')).data.incoming.length, 1);
  assert.equal((await a.del(`/api/friends/${mc.id}`)).status, 200);
  assert.equal((await a.get('/api/friends')).data.incoming.length, 0);
  assert.equal((await c.get('/api/friends')).data.outgoing.length, 0);
  // cancel your own request
  await c.post('/api/friends/request', { code: mb.friendCode });
  assert.equal((await c.del(`/api/friends/${mb.id}`)).status, 200);
  assert.equal((await b.get('/api/friends')).data.incoming.length, 0);
});

test('friends: regenerating your code cuts off old invite links but keeps friends', async () => {
  const ctx = await startApp({ mock });
  const [a, b, c] = [await as(ctx, 1), await as(ctx, 2), await as(ctx, 3)];
  const old = (await a.me()).friendCode;
  await b.post('/api/friends/request', { code: old });
  await a.post(`/api/friends/${(await b.me()).id}/accept`);
  const fresh = (await a.post('/api/me/friend-code')).data.friendCode;
  assert.notEqual(fresh, old);
  assert.equal((await c.post('/api/friends/request', { code: old })).status, 404);
  assert.equal((await c.post('/api/friends/request', { code: fresh })).status, 200);
  assert.equal((await a.get('/api/friends')).data.friends.length, 1);
});

test('friends: code guessing is throttled', async () => {
  const ctx = await startApp({ mock });
  const a = await as(ctx, 1);
  let limited = 0;
  for (let i = 0; i < 65; i++) if ((await a.post('/api/friends/lookup', { code: 'AAAAAAAAAA' })).status === 429) limited++;
  assert.equal(limited, 5);
  assert.equal((await a.post('/api/friends/request', { code: 'AAAAAAAAAA' })).status, 404); // separate allowance
});

test('friends: list size is capped', async () => {
  const ctx = await startApp({ mock });
  const a = await as(ctx, 1);
  const ids = [];
  for (let i = 0; i < 150; i++) {
    const id = `f${String(i).padStart(15, '0')}`.replace(/[^0-9a-f]/g, '0');
    ids.push(id);
  }
  // fill the list directly, then the API must refuse the 151st
  const me = Object.values(ctx.app.state.users)[0];
  for (let i = 0; i < 150; i++) {
    const u = { id: `00000000000${String(i).padStart(5, '0')}`, sub: `x${i}`, email: `x${i}@school.test`, name: 'X', classes: {}, friends: [], friendCode: `ZZZZZZZ${String(i).padStart(3, '2')}`, shareSchedule: true };
    ctx.app.state.users[u.id] = u; me.friends.push(u.id);
  }
  const extra = await as(ctx, 2);
  const r = await a.post('/api/friends/request', { code: (await extra.me()).friendCode });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /full/);
});

// ---------------------------------------------------------------- accounts

test('deleting your account removes you, your events, sessions and friend links', async () => {
  const ctx = await startApp({ mock });
  const [a, b] = [await as(ctx, 1), await as(ctx, 2)];
  const [ma, mb] = [await a.me(), await b.me()];
  await a.post('/api/friends/request', { code: mb.friendCode });
  await b.post(`/api/friends/${ma.id}/accept`);
  await a.post('/api/events', { title: 'Mine', date: soon() });
  await b.post('/api/events', { title: 'Theirs', date: soon() });
  const second = ctx.client(); await second.signIn(mock, user(1)); // another device
  assert.equal((await a.del('/api/me')).status, 200);
  assert.equal(await a.me(), null);
  assert.equal(await second.me(), null);
  assert.deepEqual((await b.get('/api/events')).data.map((e) => e.title), ['Theirs']);
  assert.equal((await b.get('/api/friends')).data.friends.length, 0);
  assert.equal(Object.keys(ctx.app.state.users).length, 1);
  assert.equal(Object.values(ctx.app.state.sessions).some((s) => s.userId === ma.id), false);
  // signing in again later starts a fresh, empty account
  const again = ctx.client(); await again.signIn(mock, user(1));
  assert.notEqual((await again.me()).id, ma.id);
  assert.deepEqual((await again.get('/api/classes')).data, {});
});

test('the shared calendar is public and starts out empty', async () => {
  const ctx = await startApp({ mock });
  const r = await ctx.client().get('/api/calendar');
  assert.equal(r.status, 200);
  assert.equal(r.data.tz, 'America/Chicago');
  assert.ok(Math.abs(r.data.serverTime - Date.now()) < 5000);
  assert.deepEqual(r.data.calendar, cal.emptyCalendar());
});
