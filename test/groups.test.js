'use strict';
// Groups, event visibility and sign-up lists, and the tools list.
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
const soon = (days = 3) => cal.addDays(cal.schoolNow('America/Chicago').date, days);
async function befriend(a, b) {
  await a.post('/api/friends/request', { code: (await b.me()).friendCode });
  await b.post('/api/friends/request', { code: (await a.me()).friendCode });
}

// ---------------------------------------------------------------- groups

test('groups: anyone starts one, it is unlisted until approved, leaders run it', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const cy = await as(ctx, 3, { given_name: 'Cy' });

  for (const bad of [{}, { name: 'x', kind: 'gang', joinPolicy: 'open' }, { name: 'x', kind: 'club', joinPolicy: 'maybe' },
    { name: 'x', kind: 'club', joinPolicy: 'open', links: [{ title: 'x', url: 'javascript:1' }] }]) {
    assert.equal((await ann.post('/api/groups', bad)).status, 400, JSON.stringify(bad));
  }
  const created = (await ann.post('/api/groups', {
    name: 'MHS-IT Club', kind: 'club', description: 'Computers!', joinPolicy: 'approval', links: [{ title: 'Discord', url: 'https://discord.example.test/it' }]
  })).data;
  assert.deepEqual([created.approved, created.myRole, created.canManage, created.links.length], [false, 'leader', true, 1]);
  assert.equal((await ben.post('/api/groups', { name: 'mhs-it club', kind: 'club', joinPolicy: 'open' })).status, 409);
  const gid = created.id;

  assert.deepEqual((await ben.get('/api/groups')).data, [], 'pending groups are unlisted');
  assert.equal((await ben.get(`/api/groups/${gid}`)).status, 404);
  assert.equal((await ben.post(`/api/groups/${gid}/join`)).status, 404);
  assert.equal((await ann.put(`/api/admin/groups/${gid}`, { approved: true })).status, 403);
  assert.equal((await boss.put(`/api/admin/groups/${gid}`, { approved: true })).status, 200);

  // approval-only joining
  assert.equal((await ben.post(`/api/groups/${gid}/join`)).data.myRole, 'requested');
  assert.equal((await cy.post(`/api/groups/${gid}/join`)).data.myRole, 'requested');
  let g = (await ann.get(`/api/groups/${gid}`)).data;
  assert.deepEqual(g.requests.map((r) => r.name), ['Ben T.', 'Cy T.']);
  assert.equal((await ben.get(`/api/groups/${gid}`)).data.members, null, 'non-members see no member list');
  const benId = (await ben.me()).id, cyId = (await cy.me()).id, annId = (await ann.me()).id;
  assert.equal((await ben.put(`/api/groups/${gid}/members/${cyId}`, { role: 'member' })).status, 403, 'only leaders accept');
  await ann.put(`/api/groups/${gid}/members/${benId}`, { role: 'member' });
  await ann.put(`/api/groups/${gid}/members/${cyId}`, { role: null }); // decline
  g = (await ben.get(`/api/groups/${gid}`)).data;
  assert.deepEqual(g.members.map((m) => [m.name, m.role]), [['Ann T.', 'leader'], ['Ben T.', 'member']]);
  assert.equal((await cy.get(`/api/groups/${gid}`)).data.myRole, null);

  // leaders
  assert.equal((await ann.post(`/api/groups/${gid}/leave`)).status, 400, 'last leader must hand over first');
  assert.equal((await ann.put(`/api/groups/${gid}/members/${annId}`, { role: 'member' })).status, 400);
  await ann.put(`/api/groups/${gid}/members/${benId}`, { role: 'leader' });
  assert.equal((await ann.post(`/api/groups/${gid}/leave`)).status, 200);
  assert.equal((await ben.put(`/api/groups/${gid}`, { joinPolicy: 'open', description: 'New text' })).data.description, 'New text');
  assert.equal((await cy.post(`/api/groups/${gid}/join`)).data.myRole, 'member', 'open groups: join at once');
  assert.equal((await cy.put(`/api/groups/${gid}`, { name: 'Hijacked' })).status, 403);
  assert.equal((await cy.del(`/api/groups/${gid}`)).status, 403);
  assert.equal((await boss.del(`/api/groups/${gid}`)).status, 200, 'admins can delete any group');
  assert.deepEqual((await ben.get('/api/groups')).data, []);
});

// ---------------------------------------------------------------- events

test('events: group-only and private events are visible only to the right people', async () => {
  const ctx = await startApp({ mock, env: { EVENT_POSTING: undefined } }); // posting public events needs verification
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const cy = await as(ctx, 3, { given_name: 'Cy' });
  const gid = (await ann.post('/api/groups', { name: 'Chess Club', kind: 'club', joinPolicy: 'open' })).data.id;
  await ben.post('/api/groups', { name: 'Other', kind: 'group', joinPolicy: 'open' });

  // a pending group can post group-only events but not public ones
  assert.equal((await ann.post('/api/events', { title: 'Meet', date: soon(), visibility: 'public', groupId: gid })).status, 400);
  assert.equal((await ann.post('/api/events', { title: 'Meet', date: soon(), visibility: 'group', groupId: gid })).status, 200);
  await boss.put(`/api/admin/groups/${gid}`, { approved: true });
  await ben.post(`/api/groups/${gid}/join`);
  // an approved group's leader may post public events without being verified
  assert.equal((await ann.post('/api/events', { title: 'Chess tournament', date: soon(4), visibility: 'public', groupId: gid })).status, 200);
  assert.equal((await ann.post('/api/events', { title: 'No group', date: soon() })).status, 403, 'still needs verification without a group');
  assert.equal((await ben.post('/api/events', { title: 'x', date: soon(), visibility: 'group', groupId: gid })).status, 403, 'members can\'t post for the group');
  assert.equal((await ann.post('/api/events', { title: 'x', date: soon(), visibility: 'group' })).status, 400);
  assert.equal((await ann.post('/api/events', { title: 'x', date: soon(), visibility: 'secret' })).status, 400);

  // private: anyone may make one, only for friends
  await befriend(ann, ben);
  const benId = (await ben.me()).id, cyId = (await cy.me()).id;
  assert.equal((await ann.post('/api/events', { title: 'x', date: soon(), visibility: 'private', invitees: [cyId] })).status, 400, 'not a friend');
  assert.equal((await ann.post('/api/events', { title: 'Movie night', date: soon(2), visibility: 'private', invitees: [benId] })).status, 200);

  const titles = async (c, q = '') => (await c.get(`/api/events${q}`)).data.map((e) => e.title).sort();
  assert.deepEqual(await titles(ann), ['Chess tournament', 'Meet', 'Movie night']);
  assert.deepEqual(await titles(ben), ['Chess tournament', 'Meet', 'Movie night']);
  assert.deepEqual(await titles(cy), ['Chess tournament']);
  assert.deepEqual(await titles(ctx.client()), ['Chess tournament'], 'anonymous: public only');
  assert.deepEqual(await titles(ben, `?group=${gid}`), ['Chess tournament', 'Meet']);
  const movie = (await ann.get('/api/events')).data.find((e) => e.title === 'Movie night');
  assert.deepEqual(movie.invitees.map((p) => p.name), ['Ben T.'], 'the organizer sees who is invited');
  assert.equal((await ben.get('/api/events')).data.find((e) => e.title === 'Movie night').invitees, undefined);
  const chess = (await ben.get('/api/events')).data.find((e) => e.title === 'Chess tournament');
  assert.deepEqual(chess.group, { id: gid, name: 'Chess Club' });

  // leaving the group hides its group-only events; deleting the group removes them
  await ben.post(`/api/groups/${gid}/leave`);
  assert.deepEqual(await titles(ben), ['Chess tournament', 'Movie night']);
  await ann.del(`/api/groups/${gid}`);
  assert.deepEqual(await titles(ann), ['Movie night']);
});

test('events: sign-up lists with limits; organizers see names, others the count', async () => {
  const ctx = await startApp({ mock });
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const cy = await as(ctx, 3, { given_name: 'Cy' });
  for (const signup of [{ limit: -1 }, { limit: 1.5 }, { limit: 501 }, 'yes']) {
    assert.equal((await ann.post('/api/events', { title: 'x', date: soon(), signup })).status, 400, JSON.stringify(signup));
  }
  const id = (await ann.post('/api/events', { title: 'Car wash', date: soon(), signup: { limit: 2 } })).data.id;
  const open = (await ann.post('/api/events', { title: 'Open list', date: soon(), signup: true })).data.id;
  const none = (await ann.post('/api/events', { title: 'No list', date: soon() })).data.id;

  assert.equal((await ben.post(`/api/events/${id}/signup`, { on: 'yes' })).status, 400);
  assert.equal((await ben.post(`/api/events/${none}/signup`, { on: true })).status, 400);
  let e = (await ben.post(`/api/events/${id}/signup`, { on: true })).data;
  assert.deepEqual([e.signup.count, e.signup.me, e.signup.people], [1, true, undefined]);
  await ben.post(`/api/events/${id}/signup`, { on: true }); // twice = still once
  await ann.post(`/api/events/${id}/signup`, { on: true });
  assert.equal((await cy.post(`/api/events/${id}/signup`, { on: true })).status, 409, 'full');
  e = (await ann.get('/api/events')).data.find((x) => x.id === id);
  assert.deepEqual([e.signup.limit, e.signup.count, e.signup.people.map((p) => p.name).sort()], [2, 2, ['Ann T.', 'Ben T.']]);
  await ben.post(`/api/events/${id}/signup`, { on: false });
  assert.equal((await cy.post(`/api/events/${id}/signup`, { on: true })).data.signup.count, 2, 'a spot opened up');
  assert.equal((await cy.post(`/api/events/${open}/signup`, { on: true })).data.signup.limit, 0);
  assert.equal((await ctx.client().get('/api/events')).data.find((x) => x.id === id).signup.me, false);

  // deleting an account takes them off sign-up lists
  await cy.del('/api/me');
  assert.equal((await ann.get('/api/events')).data.find((x) => x.id === id).signup.count, 1);
});

test('events: end times, multi-day events, a place and a kind (group events take the group\'s kind)', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  for (const bad of [{ endTime: '18:00' }, { time: '18:00', endTime: '17:00' }, { time: '18:00', endTime: '18:00' }, { endDate: soon(1) },
    { endDate: soon(40) }, { endTime: '25:00', time: '10:00' }, { endDate: 'later' }]) {
    const r = await boss.post('/api/events', { title: 'x', date: soon(2), ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const game = (await boss.post('/api/events', { title: 'Homecoming game', date: soon(2), time: '19:00', endTime: '21:30', location: 'Stadium', category: 'sports' })).data.id;
  const trip = (await boss.post('/api/events', { title: 'Band trip', date: soon(3), endDate: soon(5), location: '  Orlando, FL ' })).data.id;
  const same = (await boss.post('/api/events', { title: 'One day', date: soon(4), endDate: soon(4), category: 'nope' })).data.id;
  const gid = (await ann.post('/api/groups', { name: 'Robotics', kind: 'club', joinPolicy: 'open' })).data.id;
  await boss.put(`/api/admin/groups/${gid}`, { approved: true });
  const build = (await ann.post('/api/events', { title: 'Build night', date: soon(1), time: '15:00', visibility: 'group', groupId: gid })).data.id;
  const list = (await ann.get('/api/events')).data;
  const ev = (id) => list.find((e) => e.id === id);
  assert.deepEqual([ev(game).endTime, ev(game).location, ev(game).category, ev(game).endDate], ['21:30', 'Stadium', 'sports', null]);
  assert.deepEqual([ev(trip).endDate, ev(trip).location, ev(trip).category], [soon(5), 'Orlando, FL', 'school']);
  assert.deepEqual([ev(same).endDate, ev(same).category], [null, 'school'], 'same-day end date is dropped; unknown kind -> school');
  assert.equal(ev(build).category, 'clubs', 'a club\'s events are Clubs events unless they say otherwise');
  // the calendar feed: end time, and an all-day span through the last day
  const { url } = (await ann.post('/api/me/calendar')).data;
  const ics = await (await ctx.client().raw('GET', new URL(url).pathname, { xhr: false })).text();
  const vev = ics.split('BEGIN:VEVENT').find((v) => v.includes('Build night'));
  assert.ok(vev, 'group events are in members\' feeds');
  // an all-day span through the last day (Ann's own multi-day event)
  await ann.post('/api/events', { title: 'Camp', date: soon(6), endDate: soon(8), visibility: 'private', invitees: [] });
  const ics2 = await (await ctx.client().raw('GET', new URL(url).pathname, { xhr: false })).text();
  const camp = ics2.split('BEGIN:VEVENT').find((v) => v.includes('SUMMARY:Camp'));
  assert.match(camp, new RegExp(`DTSTART;VALUE=DATE:${soon(6).replace(/-/g, '')}`));
  assert.match(camp, new RegExp(`DTEND;VALUE=DATE:${cal.addDays(soon(8), 1).replace(/-/g, '')}`));
});

test('events: weekly repeats (club meetings) skip days off; next meeting; one calendar entry per meeting', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const t = cal.schoolNow('America/Chicago').date;
  const wd = (d) => new Date(cal.parseDate(d)).getUTCDay();
  // the next Monday on or after tomorrow, and a no-school Wednesday after it
  let mon = cal.addDays(t, 1);
  while (wd(mon) !== 1) mon = cal.addDays(mon, 1);
  const wed = cal.addDays(mon, 2);
  await boss.put('/api/admin/calendar', { noSchool: { [wed]: 'Teacher day' } });
  for (const bad of [{ repeat: { days: [], until: cal.addDays(mon, 14) } }, { repeat: { days: [1], until: cal.addDays(mon, -1) } },
    { repeat: { days: [1], until: cal.addDays(mon, 400) } }, { repeat: { days: [1], until: cal.addDays(mon, 14) }, endDate: cal.addDays(mon, 1) }, { repeat: 'weekly' }]) {
    assert.equal((await boss.post('/api/events', { title: 'x', date: mon, ...bad })).status, 400, JSON.stringify(bad));
  }
  const id = (await boss.post('/api/events', {
    title: 'Robotics', date: mon, time: '15:00', endTime: '16:30', location: 'Rm 173', repeat: { days: [3, 1, 3], until: cal.addDays(mon, 14) }
  })).data.id;
  const e = (await ann.get('/api/events')).data.find((x) => x.id === id);
  assert.deepEqual(e.repeat, { days: [1, 3], until: cal.addDays(mon, 14), skipNoSchool: true });
  assert.equal(e.next, mon);
  const sign = await ann.post(`/api/events/${id}/signup`, { on: true });
  assert.equal(sign.status, 400, 'no sign-up list on this one');
  // in Ann's calendar, each meeting of her own repeating event: Mon, (not the day-off Wed), Mon, Wed, Mon
  const own = (await ann.post('/api/events', { title: 'Study club', date: mon, time: '07:00', visibility: 'private', invitees: [], repeat: { days: [1, 3], until: cal.addDays(mon, 14) } })).data.id;
  const { url } = (await ann.post('/api/me/calendar')).data;
  const ics = await (await ctx.client().raw('GET', new URL(url).pathname, { xhr: false })).text();
  const dates = [...ics.matchAll(new RegExp(`UID:ev-${own}-(\\d{4}-\\d{2}-\\d{2})@`, 'g'))].map((m) => m[1]);
  assert.deepEqual(dates, [mon, cal.addDays(mon, 7), cal.addDays(mon, 9), cal.addDays(mon, 14)], 'the day off is skipped');
  // kept until two months after the last meeting
  assert.ok(ctx.app.state.events.some((x) => x.id === own));
});

test('backup keeps study sessions, groups, event details and tools', async () => {
  const one = await startApp({ mock });
  const boss = await owner(one);
  const ann = await as(one, 1, { given_name: 'Ann' });
  const ben = await as(one, 2, { given_name: 'Ben' });
  await befriend(ann, ben);
  await ann.put('/api/classes', { yellow: { name: 'Math' } });
  await ann.post('/api/study', { block: 'yellow', title: 'Final review', date: soon(9) });
  const gid = (await ann.post('/api/groups', { name: 'Band', kind: 'club', joinPolicy: 'approval' })).data.id;
  await ben.post('/api/groups', { name: 'Waiting', kind: 'group', joinPolicy: 'open' });
  await boss.put(`/api/admin/groups/${gid}`, { approved: true });
  await ben.post(`/api/groups/${gid}/join`);
  await ann.post('/api/events', { title: 'Practice', date: soon(), visibility: 'group', groupId: gid, signup: { limit: 5 } });
  await ann.post('/api/events', { title: 'Party', date: soon(), visibility: 'private', invitees: [(await ben.me()).id] });
  await ben.post('/api/tools/suggestions', { name: 'GPA calculator', url: 'https://gpa.example.test' });
  const backup = (await boss.get('/api/admin/backup')).data;

  const two = await startApp({ mock });
  const boss2 = await owner(two);
  assert.deepEqual((await boss2.post('/api/admin/restore', backup)).data, { users: 3, events: 2, droppedEvents: 0 });
  const s = two.app.state;
  assert.deepEqual(s.studySessions.map((i) => i.title), ['Final review']);
  assert.deepEqual(s.groups.map((g) => [g.name, g.approved, g.requests.length]).sort(), [['Band', true, 1], ['Waiting', false, 0]]);
  assert.deepEqual(s.events.map((e) => [e.title, e.visibility, e.groupId === gid, e.invitees.length, e.signup && e.signup.limit]).sort(),
    [['Party', 'private', false, 1, null], ['Practice', 'group', true, 0, 5]]);
  assert.deepEqual(s.toolSuggestions.map((t) => t.name), ['GPA calculator']);
});

// ---------------------------------------------------------------- tools

test('tools: admins manage the list; students suggest, admins accept or dismiss', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const kid = await as(ctx, 1, { given_name: 'Kim' });
  const start = (await ctx.client().get('/api/tools')).data;
  // the old Tools page is now the Tools section on Links
  for (const pth of ['/tools', '/tools.html']) {
    const r = await ctx.client().raw('GET', pth);
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/links.html#tools');
  }
  assert.deepEqual(start.map((t) => [t.name, t.url]), [['Class Cards', '']]);

  for (const bad of [{}, { name: ' ' }, { name: 'x', url: 'ftp://x' }]) assert.equal((await kid.post('/api/tools/suggestions', bad)).status, 400);
  assert.equal((await kid.post('/api/tools/suggestions', { name: 'GPA calculator', url: 'https://gpa.example.test', description: 'Work out your GPA' })).status, 200);
  await kid.post('/api/tools/suggestions', { name: 'Study timer' });
  assert.equal((await kid.get('/api/admin/tool-suggestions')).status, 403);
  const ideas = (await boss.get('/api/admin/tool-suggestions')).data;
  assert.deepEqual(ideas.map((i) => [i.name, i.by.name]), [['GPA calculator', 'Kim T.'], ['Study timer', 'Kim T.']]);
  const list = (await boss.post(`/api/admin/tool-suggestions/${ideas[0].id}/accept`)).data;
  assert.deepEqual(list.map((t) => t.name), ['Class Cards', 'GPA calculator']);
  assert.equal((await boss.del(`/api/admin/tool-suggestions/${ideas[1].id}`)).status, 200);
  assert.deepEqual((await boss.get('/api/admin/tool-suggestions')).data, []);

  assert.equal((await kid.put('/api/admin/tools', { tools: [] })).status, 403);
  assert.equal((await boss.put('/api/admin/tools', { tools: [{ name: 'x', url: 'javascript:1' }] })).status, 400);
  const saved = (await boss.put('/api/admin/tools', { tools: [list[1], { name: 'Bell timer', url: '' }] })).data;
  assert.deepEqual(saved.map((t) => [t.name, t.id === list[1].id]), [['GPA calculator', true], ['Bell timer', false]]);
});
