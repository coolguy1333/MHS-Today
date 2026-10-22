'use strict';
// Teacher accounts: picked at sign-up; their own classes (names only); Today and the groups they
// advise, nothing else. Groups invite a teacher as their advisor and the teacher accepts.
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
test.afterEach(closeAll);

async function as(ctx, n, extra, opts) {
  const c = ctx.client();
  assert.equal((await c.signIn(mock, user(n, extra), undefined, opts)).status, 302);
  return c;
}
const owner = (ctx) => as(ctx, 99, { email: 'admin@school.test', given_name: 'Ada' });
const teacher = (ctx, n, extra) => as(ctx, n, { given_name: 'Jason', family_name: 'Wienke', ...extra }, { role: 'teacher' });

test('teachers: classes without rooms or teachers; none of the student parts; never found by students', async () => {
  const ctx = await startApp({ mock });
  const t = await teacher(ctx, 5);
  const kid = await as(ctx, 1, { given_name: 'Kim' });
  const me = await t.me();
  assert.equal(me.role, 'teacher');
  assert.equal(me.searchable, false);
  const classes = (await t.put('/api/classes', { red: { name: 'Machine Tool I', teacher: 'Wienke', room: '173' }, orange: { name: 'Prep', lunch: 'B' } })).data;
  assert.deepEqual(classes, { red: { name: 'Machine Tool I', teacher: '', room: '' }, orange: { name: 'Prep', teacher: '', room: '', lunch: 'B' } });
  assert.equal((await t.put('/api/me', { grade: 11, bio: 'Tech ed' })).data.grade, null, 'no grade for teachers');
  for (const [m, p] of [['GET', '/api/friends'], ['POST', '/api/friends/search'], ['GET', '/api/friends/suggestions'], ['GET', '/api/classwork'], ['GET', '/api/study'], ['POST', '/api/me/friend-code']]) {
    assert.equal((await t.call(m, p, m === 'GET' ? undefined : { q: 'Kim' })).status, 403, `${m} ${p}`);
  }
  assert.equal((await t.post('/api/events', { title: 'Open house', date: cal.addDays(cal.schoolNow('America/Chicago').date, 2) })).status, 403, 'only for groups they advise');
  assert.equal((await t.post('/api/groups', { name: 'Tech Club', kind: 'club', joinPolicy: 'open' })).status, 403);
  // students can't find or add a teacher
  assert.deepEqual((await kid.post('/api/friends/search', { q: 'Jason' })).data.results, []);
  assert.equal((await kid.post('/api/friends/request', { code: me.friendCode })).status, 404);
  assert.equal((await kid.post('/api/friends/request', { id: me.id })).status, 404);
  // the profile and feedback still work
  assert.equal((await t.post('/api/feedback', { type: 'idea', message: 'A teacher view is great' })).status, 200);
  // admins can fix the role someone picked
  const boss = await owner(ctx);
  const kidId = (await kid.me()).id;
  assert.equal((await boss.put(`/api/admin/users/${kidId}`, { role: 'admin' })).status, 400);
  await boss.put(`/api/admin/users/${kidId}`, { role: 'teacher' });
  assert.equal((await kid.get('/api/friends')).status, 403);
  assert.equal((await boss.get('/api/admin/users')).data.find((u) => u.id === kidId).role, 'teacher');
});

test('advisors: leaders invite a teacher, who sees only that group and accepts or declines', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const lead = await as(ctx, 1, { given_name: 'Lea' });
  const kid = await as(ctx, 2, { given_name: 'Kim' });
  const t = await teacher(ctx, 5);
  const t2 = await teacher(ctx, 6, { given_name: 'Erin', family_name: 'Cuellar' });
  const make = async (name) => {
    const id = (await lead.post('/api/groups', { name, kind: 'club', joinPolicy: 'open' })).data.id;
    await boss.put(`/api/admin/groups/${id}`, { approved: true });
    return id;
  };
  const robotics = await make('Robotics');
  const chess = await make('Chess');
  assert.deepEqual((await t.get('/api/groups')).data, [], 'teachers see no groups until invited');
  assert.equal((await t.get(`/api/groups/${robotics}`)).status, 404);
  assert.equal((await t.post(`/api/groups/${robotics}/join`)).status, 404);

  assert.equal((await kid.get(`/api/groups/${robotics}/teachers?q=wie`)).status, 403, 'members who are not leaders can not invite');
  const found = (await lead.get(`/api/groups/${robotics}/teachers?q=wie`)).data;
  assert.deepEqual(found.map((x) => x.name), ['Jason W.']);
  assert.deepEqual((await lead.get(`/api/groups/${robotics}/teachers?q=kim`)).data, [], 'students are not offered');
  assert.equal((await lead.post(`/api/groups/${robotics}/advisor-invites`, { id: (await kid.me()).id })).status, 404, 'only teachers');
  const g = (await lead.post(`/api/groups/${robotics}/advisor-invites`, { id: found[0].id })).data;
  assert.deepEqual(g.advisorInvites.map((x) => x.name), ['Jason W.']);
  await lead.post(`/api/groups/${chess}/advisor-invites`, { id: (await t2.me()).id });

  const list = (await t.get('/api/groups')).data;
  assert.deepEqual(list.map((x) => [x.name, x.myRole]), [['Robotics', 'invited']]);
  const tid = (await t.me()).id;
  const joined = (await t.post(`/api/groups/${robotics}/advisor-invites/accept`)).data;
  assert.equal(joined.myRole, 'advisor');
  assert.equal(joined.members.find((x) => x.id === tid).role, 'advisor');
  assert.deepEqual(joined.advisorInvites, [], 'advisors manage the group, invitations included');
  assert.equal((await t.post(`/api/groups/${robotics}/advisor-invites/accept`)).status, 404, 'once');
  // the advisor runs the group: posts, group events; and sees only their group's events
  assert.equal((await t.post(`/api/groups/${robotics}/posts`, { text: 'Build night moved to Thursday' })).status, 200);
  const day = cal.addDays(cal.schoolNow('America/Chicago').date, 2);
  assert.equal((await t.post('/api/events', { title: 'Build night', date: day, visibility: 'group', groupId: robotics })).status, 200);
  await boss.post('/api/events', { title: 'Homecoming', date: day });
  assert.deepEqual((await t.get('/api/events')).data.map((e) => e.title), ['Build night']);
  assert.ok((await kid.get('/api/events')).data.some((e) => e.title === 'Homecoming'), 'students still see everything');
  // declining, and a leader taking an invitation back
  const t2id = (await t2.me()).id;
  assert.equal((await t2.del(`/api/groups/${chess}/advisor-invites/${t2id}`)).status, 200);
  assert.deepEqual((await t2.get('/api/groups')).data, []);
  await lead.post(`/api/groups/${chess}/advisor-invites`, { id: t2id });
  await lead.del(`/api/groups/${chess}/advisor-invites/${t2id}`);
  assert.deepEqual((await t2.get('/api/groups')).data, []);
  // a backup keeps roles and invitations
  await lead.post(`/api/groups/${chess}/advisor-invites`, { id: t2id });
  const backup = (await boss.get('/api/admin/backup')).data;
  await boss.post('/api/admin/restore', backup);
  assert.equal((await t2.me()).role, 'teacher');
  assert.deepEqual((await t2.get('/api/groups')).data.map((x) => x.myRole), ['invited']);
});

test('accounts from before roles are students', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mhs-test-'));
  const id = '00000000000000ab';
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    version: 2, sessions: {}, events: [], calendar: cal.emptyCalendar(),
    users: { [id]: { id, sub: 's1', email: 'old@school.test', name: 'Old', created: 1, lastLogin: 1, friends: [], friendCode: 'ABCDEFGHJK', shareSchedule: true, classes: {} } }
  }));
  const ctx = await startApp({ mock, tweak: (cfg) => { cfg.dataDir = dir; } });
  assert.equal(ctx.app.state.users[id].role, 'student');
});

test('calendar page items: every event you can see, your classes\' tests, your study sessions; teachers only their groups', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const t = await teacher(ctx, 5);
  const day = cal.addDays(cal.schoolNow('America/Chicago').date, 3);
  await boss.post('/api/events', { title: 'Homecoming', date: day, time: '19:00', category: 'sports' });
  const gid = (await ann.post('/api/groups', { name: 'Robotics', kind: 'club', joinPolicy: 'open' })).data.id;
  await boss.put(`/api/admin/groups/${gid}`, { approved: true });
  await ann.post('/api/events', { title: 'Build night', date: day, visibility: 'group', groupId: gid });
  await ann.put('/api/classes', { yellow: { name: 'Chemistry', teacher: 'Mole' } });
  await ben.put('/api/classes', { yellow: { name: 'Chemistry', teacher: 'Mole' } });
  await ben.post('/api/classwork', { block: 'yellow', kind: 'quiz', title: 'Moles', due: day });
  const items = (await ann.get('/api/me/calendar/items')).data.items;
  assert.deepEqual(items.map((i) => [i.kind, i.title]).sort(), [['classwork', 'Quiz: Moles (Chemistry)'], ['event', 'Homecoming'], ['group', 'Build night']]);
  assert.equal(items.find((i) => i.kind === 'event').mine, false, 'shown on the page though it isn\'t in the calendar feed');
  assert.deepEqual((await ben.get('/api/me/calendar/items')).data.items.map((i) => i.title).sort(), ['Homecoming', 'Quiz: Moles (Chemistry)'], 'not a member: no group event');
  const lead = await ann.me();
  await ann.post(`/api/groups/${gid}/advisor-invites`, { id: (await t.me()).id });
  await t.post(`/api/groups/${gid}/advisor-invites/accept`);
  assert.deepEqual((await t.get('/api/me/calendar/items')).data.items.map((i) => i.title), ['Build night'], 'teachers: their groups only');
  assert.ok(lead.id);
});
