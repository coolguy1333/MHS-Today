'use strict';
// Odd, hostile and half-right requests to every API route, as each kind of person. Whatever is sent,
// the answer must be a clear 4xx (or a 2xx): never a server error, never a crash in the log.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// no rate limits here, so every request reaches its handler (this file runs in its own process)
require('../src/util').RateLimiter.prototype.hit = () => true;
const { startApp, closeAll } = require('./helpers');
const { startMockGoogle } = require('./mock-google');

let mock;
test.before(async () => { mock = await startMockGoogle(); });
test.after(async () => { await mock.close(); });
test.afterEach(closeAll);

// every route(...) in src/
const ROUTES = [];
for (const f of fs.readdirSync(path.join(__dirname, '..', 'src'))) {
  for (const m of fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8').matchAll(/route\('([A-Z]+)', '([^']+)'/g)) ROUTES.push([m[1], m[2]]);
}
const BODIES = [
  undefined, [], 'x',
  JSON.parse('{"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}}}'),
  // the right field names with the wrong kinds of values
  { id: {}, code: [], q: {}, name: {}, title: [], text: 5, date: {}, due: [], block: {}, kind: 1, on: 'x', level: {}, role: [], version: {}, options: 'x', question: {}, limit: 'x', signup: 'x', invitees: 'x', groupId: {}, announcements: 'x', countdowns: {}, blockedWords: 5, links: 'x', tools: 'x', avatar: 'x', interests: 'x', image: 5, subscription: 'x', endpoint: {}, graduation: {}, repeat: 'x', time: {}, status: {}, reason: [], ref: 'x', type: {}, message: {}, users: 'x', calendar: 5 },
  // the right kinds, with values that make no sense
  { id: 'x'.repeat(3000), title: 'x'.repeat(3000), text: '\u0000‮'.repeat(100), date: '2026-13-45', due: '0000-00-00', time: '99:99', block: 'yellow', kind: 'quiz', name: '\u{1F9EA}'.repeat(80), limit: -1, signup: { limit: 1e308 }, repeat: { every: 'week', until: 'never', days: [9] }, invitees: [{}, null, 1], options: [{}, null, 1, 'a', 'a'], ref: { id: {}, group: [] }, yellow: 'x', red: null, pink: { name: {} }, avatar: { emoji: {}, color: {} }, interests: [{}, null], subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: {}, auth: [] } }, links: [null, {}, { title: {}, url: [] }], tools: [null, {}, 5], announcements: [null, 5, { text: {}, start: [], end: {} }], countdowns: [null, { title: {}, date: {} }], blockedWords: [{}, null, 5], anchorDate: {}, noSchool: 'x', types: [], weekdayTypes: 5, customTypes: [null], users: [null, 5, {}], events: [null, 5], groups: [null, 5, {}], plans: [5], classEvents: [5], studySessions: [5], feedback: [5], todos: [5], version: 2, app: 'mhs-hub' },
  // nearly right
  { title: 'Ok', text: 'Ok', name: 'Ok name', date: '2026-10-02', due: '2026-10-02', block: 'yellow', kind: 'quiz', question: 'Q?', options: ['a', 'b'], visibility: 'group', groupId: 'nope', joinPolicy: 'open', type: 'idea', message: 'hi', on: true, done: true, level: 'full', code: 'ABCDEFGHJK', q: 'ann', role: 'leader', anchorDate: '2026-10-01', anchorLetter: 'A', customTypes: { x: { name: 'X', periods: [{}] } }, repeat: { every: 'week', until: '2026-12-01' }, signup: { limit: 3 }, reason: 'spam', ref: { id: 'x' }, status: 'done', calendar: { noSchool: [] } }
];
const QUERIES = ['', '?from=x&to=y&date=zz&q=%00&group=__proto__&kind=x&who=%ff&before=-1&limit=1e9&endpoint=x', '?from=2026-10-05&to=2026-10-01&date=9999-99-99&q=a&before=5'];

test('no request, however odd, makes the server fail', async () => {
  const realNow = Date.now;
  const start = realNow();
  Date.now = () => Date.parse('2026-10-01T15:00:00Z') + (realNow() - start); // a school morning
  try {
    const ctx = await startApp({ mock, env: { GOOGLE_TASKS: 'on' } });
    const as = async (sub, email, given, role = 'student') => {
      const c = ctx.client();
      await c.signIn(mock, { sub, email, given_name: given, family_name: 'Test' }, null, { role });
      return c;
    };
    const admin = await as('a1', 'admin@school.test', 'Ada'), ann = await as('s1', 'ann@school.test', 'Ann'), ben = await as('s2', 'ben@school.test', 'Ben'), tea = await as('t1', 't@school.test', 'Tee', 'teacher');
    await admin.put('/api/admin/calendar', { anchorDate: '2026-10-01', anchorLetter: 'A' });
    for (const c of [ann, ben]) await c.put('/api/classes', { yellow: { name: 'English', teacher: 'Test' }, green: { name: 'Span', teacher: 'Sol', lunch: 'B' } });
    await tea.put('/api/classes', { yellow: { name: 'English' } });
    const annId = (await ann.me()).id, benId = (await ben.me()).id;
    await ann.post('/api/friends/request', { code: (await ben.me()).friendCode });
    await ben.post(`/api/friends/${annId}/accept`);
    const g = (await ann.post('/api/groups', { name: 'Robotics', kind: 'club', joinPolicy: 'open' })).data;
    await admin.put(`/api/admin/groups/${g.id}`, { approved: true });
    const post = (await ann.post(`/api/groups/${g.id}/posts`, { text: 'hello' })).data;
    const ev = (await ann.post('/api/events', { title: 'E', date: '2026-10-02', visibility: 'public', signup: { limit: 2 } })).data;
    const cw = (await ann.post('/api/classwork', { block: 'yellow', kind: 'quiz', title: 'Q', due: '2026-10-02' })).data;
    const st = (await ann.post('/api/study', { block: 'yellow', title: 'S', date: '2026-10-02' })).data;
    const ids = {
      id: [g.id, ev.id, cw.id, st.id, benId, 'ffffffffffffffff', '__proto__', '%00'], pid: [post.id, '__proto__'], rid: ['nope'], uid: [benId, '__proto__'], list: ['list-main'], task: ['..%2f..']
    };
    const failures = [];
    let sent = 0;
    for (const [who, c] of Object.entries({ anon: ctx.client(), ann, teacher: tea, admin })) { // admin last: it may change a lot
      for (const [method, pattern] of ROUTES) {
        if ((method === 'DELETE' && pattern === '/api/me') || pattern === '/api/logout') continue; // they'd end the session mid-run
        const names = [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]);
        const fill = (first) => pattern.replace(`:${names[0]}`, first).replace(/:(\w+)/g, (_, k) => (ids[k] || ['x'])[0]);
        const paths = names.length ? (ids[names[0]] || ['x']).map(fill) : [pattern];
        if (names.length > 1) for (const v of ids[names[1]] || []) paths.push(pattern.replace(`:${names[0]}`, ids[names[0]][0]).replace(`:${names[1]}`, v));
        for (const p of paths) {
          for (const q of method === 'GET' ? QUERIES : ['']) {
            for (const body of method === 'GET' ? [undefined] : BODIES) {
              sent++;
              const r = await c.call(method, p + q, body);
              if (r.status >= 500) failures.push(`${who} ${method} ${p}${q} ${JSON.stringify(body || null).slice(0, 60)} -> ${r.status}`);
            }
          }
        }
      }
    }
    // not JSON, the wrong type, far too big, and paths that try to leave the public folder
    const cookie = [...ann.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const raw = async (method, p, body, type) => {
      sent++;
      const r = await fetch(ctx.local + p, { method, body, headers: { 'x-requested-with': 'mhs', cookie, ...(type ? { 'content-type': type } : {}) } });
      if (r.status >= 500) failures.push(`raw ${method} ${p} -> ${r.status}`);
      return r;
    };
    await raw('POST', '/api/events', '{bad json', 'application/json');
    await raw('POST', '/api/events', 'a=b', 'application/x-www-form-urlencoded');
    assert.equal((await raw('POST', '/api/events', JSON.stringify({ title: 'x'.repeat(2e6) }), 'application/json')).status, 413);
    for (const p of ['/%', '/%00', '/..%2f..%2fserver.js', '/.env', '/css/', '/photos/..%2f..%2fdb.json', '/cal/x.ics', `/cal/${'a'.repeat(48)}.ics`, '/api', '/api//me', '/auth/google/callback?state=x&code=y', `/simple?heading=${'%F0'.repeat(50)}`, `/index.html?${'a'.repeat(6000)}`]) {
      const r = await raw('GET', p);
      assert.doesNotMatch(await r.text(), /createApp|"users":/, `${p} must not leak server files or data`);
    }
    assert.ok(sent > 1500, `${sent} requests`);
    assert.deepEqual(failures.slice(0, 10), []);
    assert.deepEqual(ctx.logs.filter((l) => /Unhandled error|Fatal request/.test(l)).map((l) => l.split('\n').slice(0, 3).join(' | ')).slice(0, 5), []);
    assert.equal((await ctx.client().get('/api/health')).status, 200, 'still healthy afterwards');
  } finally { Date.now = realNow; }
});

test('the health check says so when data stops being saved', async () => {
  const ctx = await startApp({ mock });
  const c = ctx.client();
  assert.deepEqual((await c.get('/api/health')).data, { ok: true });
  // the data folder goes away under the app (a full or unmounted disk behaves the same: writes fail)
  const realNow = Date.now;
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  fs.writeFileSync(ctx.dataDir, 'not a folder');
  try {
    await c.signIn(mock, { sub: 'h1', email: 'h1@school.test' }); // a change that needs saving
    ctx.app.flush();
    assert.equal((await c.get('/api/health')).status, 200, 'a short hiccup is not an alarm');
    const later = realNow() + 2 * 60e3;
    Date.now = () => later;
    assert.equal((await c.get('/api/health')).status, 503);
    assert.ok(ctx.logs.some((l) => /Could not save data/.test(l)));
    // back again: the next save works and the check is green
    Date.now = realNow;
    fs.rmSync(ctx.dataDir, { force: true });
    fs.mkdirSync(ctx.dataDir, { recursive: true });
    ctx.app.flush();
    assert.equal((await c.get('/api/health')).status, 200);
  } finally { Date.now = realNow; }
});
