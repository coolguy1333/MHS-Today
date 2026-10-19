'use strict';
// Club advisors, and graduation day (seniors archived, everyone else moves up a grade).
const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../public/js/calendar.js');
const { startApp, closeAll, user } = require('./helpers');
const { startMockGoogle } = require('./mock-google');

let mock;
test.before(async () => { mock = await startMockGoogle(); });
test.after(async () => { await mock.close(); });
test.afterEach(closeAll);

async function as(ctx, n, extra) {
  const c = ctx.client();
  assert.equal((await c.signIn(mock, user(n, extra))).status, 302);
  return c;
}
const owner = (ctx) => as(ctx, 99, { email: 'admin@school.test', given_name: 'Ada' });
const today = () => cal.schoolNow('America/Chicago').date;

test('advisors: only admins make one; an advisor runs the group like a leader; the advisor\'s name shows', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const lead = await as(ctx, 1, { given_name: 'Lea' });
  const teach = await as(ctx, 2, { given_name: 'Tom', email: 'wienke@school.test' });
  const gid = (await lead.post('/api/groups', { name: 'Robotics', kind: 'club', joinPolicy: 'open', advisor: ' Mr. Wienke ' })).data.id;
  await boss.put(`/api/admin/groups/${gid}`, { approved: true });
  await teach.post(`/api/groups/${gid}/join`);
  const tid = (await teach.me()).id;
  assert.equal((await lead.put(`/api/groups/${gid}/members/${tid}`, { role: 'advisor' })).status, 403, 'leaders can\'t make advisors');
  const g = (await boss.put(`/api/groups/${gid}/members/${tid}`, { role: 'advisor' })).data;
  assert.equal(g.advisor, 'Mr. Wienke');
  assert.deepEqual(g.members.map((m) => [m.name, m.role]), [['Tom T.', 'advisor'], ['Lea T.', 'leader']], 'advisors listed first');
  assert.equal((await lead.put(`/api/groups/${gid}/members/${tid}`, { role: 'member' })).status, 403, 'leaders can\'t remove an advisor');
  // the advisor manages it: edits, posts group events, and is enough of a leader for the student leader to leave
  assert.equal((await teach.put(`/api/groups/${gid}`, { description: 'Build season!' })).status, 200);
  assert.equal((await teach.post('/api/events', { title: 'Build night', date: cal.addDays(today(), 2), visibility: 'group', groupId: gid })).status, 200);
  assert.equal((await lead.post(`/api/groups/${gid}/leave`)).status, 200);
  assert.equal((await teach.get(`/api/groups/${gid}`)).data.myRole, 'advisor');
});

test('graduation: seniors archived (no sign-in, out of search and friends lists), the rest move up; restore; deleted after 90 days', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const sam = await as(ctx, 1, { given_name: 'Sam' });
  const jo = await as(ctx, 2, { given_name: 'Jo' });
  await sam.put('/api/me', { grade: 12 });
  await jo.put('/api/me', { grade: 10 });
  await sam.post('/api/friends/request', { code: (await jo.me()).friendCode });
  await jo.post('/api/friends/request', { code: (await sam.me()).friendCode });
  const samId = (await sam.me()).id;

  assert.equal((await boss.put('/api/admin/school', { graduation: 'soon' })).status, 400);
  await boss.put('/api/admin/school', { graduation: cal.addDays(today(), 3) });
  let st = (await boss.get('/api/admin/status')).data;
  assert.deepEqual([st.graduation, st.seniors, st.archived], [cal.addDays(today(), 3), 1, 0]);
  ctx.app.runMaintenance();
  assert.ok(!ctx.app.state.users[samId].archived, 'not before the day');

  await boss.put('/api/admin/school', { graduation: today() });
  ctx.app.runMaintenance();
  ctx.app.runMaintenance(); // only once per graduation day
  assert.ok(ctx.app.state.users[samId].archived);
  assert.equal((await jo.me()).grade, 11, 'everyone else moves up a grade');
  assert.equal((await sam.get('/api/me')).data.user, null, 'signed out');
  const again = ctx.client();
  const r = await again.signIn(mock, user(1, { given_name: 'Sam' }), undefined, { agree: false });
  assert.equal(r.headers.get('location'), '/login.html?error=archived');
  assert.deepEqual((await jo.get('/api/friends')).data.friends, [], 'gone from friends lists');
  assert.deepEqual((await jo.post('/api/friends/search', { q: 'Sam' })).data.results, []);
  st = (await boss.get('/api/admin/status')).data;
  assert.deepEqual([st.seniors, st.archived], [0, 1]);
  const audit = (await boss.get('/api/admin/audit?q=graduation')).data.entries;
  assert.deepEqual(audit[0].detail, { date: today(), archived: 1, movedUp: 1 });

  // an admin can restore someone archived by mistake
  assert.equal((await boss.put(`/api/admin/users/${samId}`, { archived: true })).status, 400);
  await boss.put(`/api/admin/users/${samId}`, { archived: false });
  assert.equal((await again.signIn(mock, user(1, { given_name: 'Sam' }))).headers.get('location'), '/index.html', 'signs in again');
  // archived accounts are deleted 90 days later
  await boss.put('/api/admin/school', { graduation: cal.addDays(today(), 1) });
  ctx.app.state.users[samId].archived = { at: Date.now(), deleteAfter: Date.now() - 1 };
  ctx.app.runMaintenance();
  assert.equal(ctx.app.state.users[samId], undefined);
});
