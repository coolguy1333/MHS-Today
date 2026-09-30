'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cal = require('../public/js/calendar.js');
const { startApp, closeAll, user } = require('./helpers');
const { startMockGoogle } = require('./mock-google');

let mock;
test.before(async () => { mock = await startMockGoogle(); });
test.after(async () => { await mock.close(); });
test.beforeEach(() => { mock.claimOverrides = {}; });
test.afterEach(closeAll);

async function as(ctx, n, extra) { const c = ctx.client(); await c.signIn(mock, user(n, extra)); return c; }
const admin = (ctx) => as(ctx, 99, { email: 'admin@school.test', given_name: 'Ada', family_name: 'Min' });
const today = () => cal.schoolNow('America/Chicago').date;

test('every admin endpoint refuses ordinary students', async () => {
  const ctx = await startApp({ mock });
  const kid = await as(ctx, 1);
  for (const [m, p, b] of [['GET', '/api/admin/status'], ['GET', '/api/admin/users'], ['DELETE', '/api/admin/users/0123456789abcdef'],
    ['PUT', '/api/admin/calendar', {}], ['GET', '/api/admin/backup'], ['POST', '/api/admin/restore', {}]]) {
    assert.equal((await kid.call(m, p, b)).status, 403, `${m} ${p}`);
  }
});

test('calendar: admin saves it, everyone sees it, junk is dropped', async () => {
  const ctx = await startApp({ mock });
  const boss = await admin(ctx);
  const t = today();
  const r = await boss.put('/api/admin/calendar', {
    anchorDate: t, anchorLetter: 'C', noSchool: { [cal.addDays(t, 10)]: 'Fall break', nope: 'x' },
    types: { [cal.addDays(t, 3)]: 'advisory', [cal.addDays(t, 4)]: 'bogus' }, weekdayTypes: { 3: 'early_release' }, evil: 'field'
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.noSchool, { [cal.addDays(t, 10)]: 'Fall break' });
  assert.equal(r.data.evil, undefined);
  assert.deepEqual(r.data.types, { [cal.addDays(t, 3)]: 'advisory' });
  const pub = (await ctx.client().get('/api/calendar')).data.calendar;
  assert.deepEqual(pub, r.data);
  // server and browser run the same code, so the letter the page shows is this one:
  const info = cal.dayInfo(pub, cal.nextSchoolDay(pub, cal.addDays(t, -1)));
  assert.ok(info.dayLetter === 'C' || !info.schoolDay === false);
  assert.equal((await boss.put('/api/admin/calendar', [])).status, 400);
  assert.equal((await boss.put('/api/admin/calendar', 'nope')).status, 400);
  const cleared = await boss.put('/api/admin/calendar', {});
  assert.deepEqual(cleared.data, cal.emptyCalendar());
});

test('calendar: old entries are pruned when saving', async () => {
  const ctx = await startApp({ mock });
  const boss = await admin(ctx);
  const r = await boss.put('/api/admin/calendar', { noSchool: { '2020-01-01': 'ancient', [cal.addDays(today(), 5)]: 'soon' } });
  assert.deepEqual(Object.keys(r.data.noSchool), [cal.addDays(today(), 5)]);
});

test('users: listed for admins only, removable, but not yourself', async () => {
  const ctx = await startApp({ mock });
  const boss = await admin(ctx);
  const kid = await as(ctx, 1, { given_name: 'Kim' });
  const list = (await boss.get('/api/admin/users')).data;
  assert.equal(list.length, 2);
  const row = list.find((u) => u.email === 'user1@school.test');
  assert.equal(row.name, 'Kim T.'); assert.equal(row.admin, false);
  assert.equal(list.find((u) => u.admin).email, 'admin@school.test');
  assert.equal((await boss.del(`/api/admin/users/${(await boss.me()).id}`)).status, 400);
  assert.equal((await boss.del('/api/admin/users/0123456789abcdef')).status, 404);
  await kid.post('/api/events', { title: 'Kim event', date: today() });
  assert.equal((await boss.del(`/api/admin/users/${row.id}`)).status, 200);
  assert.equal(await kid.me(), null);
  assert.equal((await boss.get('/api/events')).data.length, 0);
  assert.equal((await boss.get('/api/admin/users')).data.length, 1);
});

test('status page data describes the setup without revealing secrets', async () => {
  const ctx = await startApp({ mock, env: { ALLOWED_DOMAINS: 'school.test', PUBLIC_URL: 'https://hub.example.test' } });
  const boss = await admin(ctx);
  const s = (await boss.get('/api/admin/status')).data;
  assert.equal(s.redirectUri, 'https://hub.example.test/auth/google/callback');
  assert.equal(s.signIn, true); assert.equal(s.secureCookies, true);
  assert.deepEqual(s.allowedDomains, ['school.test']);
  assert.equal(s.users, 1); assert.equal(s.tz, 'America/Chicago'); assert.match(s.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(s.lastSnapshot, /^db-\d{4}-\d{2}-\d{2}\.json$/);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('test-secret') && !text.includes('admin@school.test'));
});

async function populate(ctx) {
  const boss = await admin(ctx);
  const [a, b] = [await as(ctx, 1, { given_name: 'Ann' }), await as(ctx, 2, { given_name: 'Ben' })];
  await a.put('/api/classes', { A_1: { name: 'Math', teacher: 'Smith', room: '1', color: '#112233' } });
  await b.put('/api/me', { shareSchedule: false });
  await a.post('/api/friends/request', { code: (await b.me()).friendCode });
  await b.post(`/api/friends/${(await a.me()).id}/accept`);
  await a.post('/api/events', { title: 'Game night', date: cal.addDays(today(), 4), time: '19:00', description: 'Bring snacks' });
  await boss.put('/api/admin/calendar', { anchorDate: today(), anchorLetter: 'D', noSchool: { [cal.addDays(today(), 9)]: 'Break' } });
  return { boss, a, b };
}

test('backup: downloadable file with everything needed and nothing sensitive', async () => {
  const ctx = await startApp({ mock });
  const { boss } = await populate(ctx);
  const r = await boss.get('/api/admin/backup');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="mhs-hub-backup-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.data.app, 'mhs-hub'); assert.equal(r.data.version, 2);
  assert.equal(r.data.users.length, 3); assert.equal(r.data.events.length, 1);
  assert.equal(r.data.calendar.anchorLetter, 'D');
  const text = JSON.stringify(r.data);
  assert.ok(!('sessions' in r.data));
  for (const token of ctx.app.state.sessions ? Object.keys(ctx.app.state.sessions) : []) assert.ok(!text.includes(token), 'no session data');
  assert.ok(!text.includes('test-secret'));
});

test('restore: a backup rebuilds an empty server exactly, and sign-in finds the old account', async () => {
  const one = await startApp({ mock });
  const { boss, a } = await populate(one);
  const backup = (await boss.get('/api/admin/backup')).data;
  const annBefore = await a.me();
  const friendsBefore = (await a.get('/api/friends')).data;

  const two = await startApp({ mock });
  const newBoss = await admin(two); // the new server already has its own admin account
  const res = await newBoss.post('/api/admin/restore', backup);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { users: 3, events: 1, droppedEvents: 0 });
  assert.ok(two.logs.some((l) => /Data restored from a backup file by admin/.test(l)));
  assert.equal(fs.readdirSync(path.join(two.dataDir, 'backups')).filter((n) => n.startsWith('before-restore-')).length, 1);

  // the restoring admin's session survives only if they are in the backup (they are: same Google account)
  assert.equal(await newBoss.me(), null, 'a fresh admin account is replaced by the backed-up one');
  const ann = two.client();
  await ann.signIn(mock, user(1, { given_name: 'Ann' }));
  const annAfter = await ann.me();
  assert.equal(annAfter.id, annBefore.id);
  assert.equal(annAfter.friendCode, annBefore.friendCode);
  assert.deepEqual((await ann.get('/api/classes')).data, { A_1: { name: 'Math', teacher: 'Smith', room: '1', color: '#112233' } });
  const friendsAfter = (await ann.get('/api/friends')).data;
  assert.deepEqual(friendsAfter.friends.map((f) => [f.id, f.name, f.classes]), friendsBefore.friends.map((f) => [f.id, f.name, f.classes]));
  assert.equal(friendsAfter.friends[0].classes, null, 'privacy setting survived');
  const events = (await ann.get('/api/events')).data;
  assert.deepEqual(events.map((e) => [e.title, e.time, e.description, e.mine]), [['Game night', '19:00', 'Bring snacks', true]]);
  assert.equal((await ctx_calendar(two)).anchorLetter, 'D');
  const adminAgain = two.client();
  await adminAgain.signIn(mock, user(99, { email: 'admin@school.test' }));
  assert.equal((await adminAgain.me()).admin, true);
  assert.equal((await adminAgain.get('/api/admin/users')).data.length, 3);
});
const ctx_calendar = async (ctx) => (await ctx.client().get('/api/calendar')).data.calendar;

test('restore: keeps the current admin signed in when they are in the backup', async () => {
  const ctx = await startApp({ mock });
  const { boss } = await populate(ctx);
  const backup = (await boss.get('/api/admin/backup')).data;
  assert.equal((await boss.post('/api/admin/restore', backup)).status, 200);
  assert.ok(await boss.me());
});

test('restore: takes a safety copy of the current data first', async () => {
  const ctx = await startApp({ mock });
  const { boss } = await populate(ctx);
  const backup = (await boss.get('/api/admin/backup')).data;
  await as(ctx, 5, { given_name: 'Newcomer' });
  assert.equal(Object.keys(ctx.app.state.users).length, 4);
  await boss.post('/api/admin/restore', backup);
  assert.equal(Object.keys(ctx.app.state.users).length, 3);
  const dir = path.join(ctx.dataDir, 'backups');
  const snap = fs.readdirSync(dir).find((n) => n.startsWith('before-restore-'));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, snap), 'utf8'));
  assert.equal(Object.keys(saved.users).length, 4);
  assert.deepEqual(saved.sessions, {}, 'snapshots never contain sessions');
});

test('restore: refuses files that are not backups, and changes nothing', async () => {
  const ctx = await startApp({ mock });
  const { boss, a } = await populate(ctx);
  const good = (await boss.get('/api/admin/backup')).data;
  const before = JSON.stringify(ctx.app.state.users);
  const bads = [
    {}, { app: 'other', version: 2, users: [] }, { ...good, version: 1 }, { ...good, version: 3 }, { ...good, users: 'nope' },
    { ...good, users: [{ ...good.users[0], id: 'short' }] }, { ...good, users: [{ ...good.users[0], id: '../../etc/passwd' }] },
    { ...good, users: [good.users[0], good.users[0]] },
    { ...good, users: [good.users[0], { ...good.users[1], sub: good.users[0].sub }] },
    { ...good, users: [{ ...good.users[0], sub: '' }] }, { ...good, users: [{ ...good.users[0], email: 5 }] }, { ...good, users: [null] },
    { ...good, users: Array.from({ length: 5001 }, (_, i) => ({ id: i.toString(16).padStart(16, '0'), sub: String(i), email: 'x@y.z' })) }
  ];
  for (const b of bads) assert.equal((await boss.post('/api/admin/restore', b)).status, 400, JSON.stringify(b).slice(0, 80));
  assert.equal(JSON.stringify(ctx.app.state.users), before);
  assert.equal((await a.get('/api/events')).data.length, 1);
  assert.equal(fs.readdirSync(path.join(ctx.dataDir, 'backups')).some((n) => n.startsWith('before-restore-')), false, 'no safety copy for refused restores');
});

test('restore: everything in the file is sanitised like fresh input', async () => {
  const ctx = await startApp({ mock });
  const boss = await admin(ctx);
  const id = (n) => n.toString(16).padStart(16, '0');
  const t = today();
  const evil = {
    app: 'mhs-hub', version: 2,
    users: [
      { id: id(1), sub: 's1', email: 'ONE@School.test', name: '  Evil‮  name ' + 'x'.repeat(100), created: 'nope', lastLogin: -5,
        classes: { A_1: { name: '<b>x</b>', color: 'javascript:1' }, Z_9: { name: 'bad' }, __proto__: { a: 1 } },
        friends: [id(2), id(1), id(99), '__proto__', 7, id(2)], friendCode: 'lowercase-bad', shareSchedule: 'yes', isAdmin: true, admin: true },
      { id: id(2), sub: 's2', email: 'two@school.test', name: '', friendCode: 'ABCDEFGHJK', friends: 'not an array', classes: 5 },
      { id: id(3), sub: 's3', email: 'three@school.test', name: 'Dup code', friendCode: 'ABCDEFGHJK' }
    ],
    events: [
      { id: id(10), title: 'Fine', date: cal.addDays(t, 3), time: '10:00', description: 'ok', by: id(1) },
      { id: id(11), title: 'Orphan author', date: cal.addDays(t, 3), by: id(77) },
      { id: 'bad', title: 'Bad id', date: cal.addDays(t, 3) },
      { id: id(12), title: '', date: cal.addDays(t, 3) },
      { id: id(13), title: 'Bad date', date: '2026-99-99' },
      { id: id(14), title: 'Ancient', date: '2001-01-01' },
      { id: id(15), title: 'Old but in retention window', date: cal.addDays(t, -40) },
      'string', null
    ],
    calendar: { anchorDate: 'x', noSchool: { [t]: 'ok', bad: 1 }, weekdayTypes: { 9: 'advisory' }, extra: 1 }
  };
  const r = await boss.post('/api/admin/restore', evil);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { users: 3, events: 3, droppedEvents: 6 }); // bad id, empty title, bad date, too old, a string, null
  const users = Object.values(ctx.app.state.users);
  const u1 = users.find((u) => u.id === id(1)); const u2 = users.find((u) => u.id === id(2)); const u3 = users.find((u) => u.id === id(3));
  assert.equal(u1.email, 'one@school.test');
  assert.equal(u1.name, 'Evil name ' + 'x'.repeat(30)); // 40 characters in total
  assert.equal(u1.created, 0); assert.equal(u1.lastLogin, 0);
  assert.deepEqual(Object.keys(u1.classes), ['A_1']); assert.equal(u1.classes.A_1.color, '#4f7cff');
  assert.deepEqual(u1.friends, [id(2)]);
  assert.equal(u1.shareSchedule, true);
  assert.equal(u1.admin, undefined);
  assert.match(u1.friendCode, /^[A-HJKMNP-Z2-9]{10}$/); assert.notEqual(u1.friendCode, 'lowercase-bad');
  assert.equal(u2.name, 'Student'); assert.deepEqual(u2.friends, []); assert.deepEqual(u2.classes, {});
  assert.equal(new Set(users.map((u) => u.friendCode)).size, 3, 'friend codes stay unique');
  assert.equal(u2.friendCode, 'ABCDEFGHJK'); assert.notEqual(u3.friendCode, 'ABCDEFGHJK');
  const ev = (await boss.get('/api/events')).data.map((e) => e.title);
  assert.deepEqual(ev.sort(), ['Fine', 'Old but in retention window', 'Orphan author']);
  assert.equal(ctx.app.state.events.find((e) => e.title === 'Orphan author').by, null);
  assert.deepEqual(ctx.app.state.calendar, { anchorDate: null, anchorLetter: 'A', noSchool: { [t]: 'ok' }, types: {}, weekdayTypes: {} });
});

test('restore: size limit and admin-only', async () => {
  const ctx = await startApp({ mock });
  const boss = await admin(ctx);
  const kid = await as(ctx, 1);
  assert.equal((await kid.post('/api/admin/restore', { app: 'mhs-hub', version: 2, users: [] })).status, 403);
  // up to 12 MB is accepted for restores; anything bigger is refused quickly
  const huge = JSON.stringify({ app: 'mhs-hub', version: 2, users: [], pad: 'x'.repeat(13 * 1024 * 1024) });
  let status;
  try { status = (await boss.post('/api/admin/restore', huge)).status; } catch { status = 'closed'; }
  assert.ok(status === 413 || status === 'closed', String(status));
  const pad = JSON.stringify({ app: 'mhs-hub', version: 2, users: [], events: [], pad: 'x'.repeat(5 * 1024 * 1024) });
  assert.equal((await boss.post('/api/admin/restore', pad)).status, 200);
  assert.equal((await boss.get('/api/health')).status, 200);
});
