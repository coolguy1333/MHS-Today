'use strict';
// Admins managed in the app, the Links page, fuller profiles and "people you may know".
const test = require('node:test');
const assert = require('node:assert/strict');
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
const owner = (ctx) => as(ctx, 99, { email: 'admin@school.test', given_name: 'Ada', family_name: 'Min' });
async function befriend(a, b) {
  await a.post('/api/friends/request', { code: (await b.me()).friendCode });
  await b.post('/api/friends/request', { code: (await a.me()).friendCode });
}

// ---------------------------------------------------------------- admins

test('admins: an admin can promote and demote people; owners and yourself are protected', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const kim = await as(ctx, 1, { given_name: 'Kim' });
  const lee = await as(ctx, 2, { given_name: 'Lee' });
  const kimId = (await kim.me()).id, leeId = (await lee.me()).id, bossId = (await boss.me()).id;

  assert.equal((await kim.get('/api/admin/users')).status, 403);
  assert.equal((await boss.put(`/api/admin/users/${kimId}`, { admin: 'yes' })).status, 400);
  assert.equal((await boss.put(`/api/admin/users/${kimId}`, { admin: true })).data.admin, true);
  assert.equal((await kim.me()).admin, true);
  const rows = (await kim.get('/api/admin/users')).data;
  assert.equal(rows.find((u) => u.id === bossId).owner, true);
  assert.equal(rows.find((u) => u.id === kimId).owner, false);

  // a promoted admin can promote others, but can't touch owners or their own role
  assert.equal((await kim.put(`/api/admin/users/${leeId}`, { admin: true })).status, 200);
  assert.equal((await kim.put(`/api/admin/users/${bossId}`, { admin: false })).status, 400);
  assert.equal((await kim.put(`/api/admin/users/${kimId}`, { admin: false })).status, 400);
  assert.equal((await kim.del(`/api/admin/users/${bossId}`)).status, 403);
  assert.equal((await lee.put(`/api/admin/users/${kimId}`, { admin: false })).status, 200);
  assert.equal((await kim.me()).admin, false);
  assert.equal((await kim.get('/api/admin/users')).status, 403);
  assert.ok(ctx.logs.some((l) => new RegExp(`User ${kimId} changed \\(admin\\) by admin ${leeId}`).test(l)));

  // kept in backups
  const backup = (await boss.get('/api/admin/backup')).data;
  assert.equal(backup.users.find((u) => u.id === leeId).adminGranted, true);
});

// ---------------------------------------------------------------- links

test('links: start with the MHS defaults, anyone can read them, admins replace the list', async () => {
  const ctx = await startApp({ mock });
  const anon = ctx.client();
  const start = (await anon.get('/api/links')).data;
  assert.ok(start.length >= 10);
  assert.ok(start.some((l) => l.category === 'Tickets & events' && /justagame\.com/.test(l.url)));
  assert.ok(start.every((l) => /^[0-9a-f]{16}$/.test(l.id) && /^https:\/\//.test(l.url)));

  const kid = await as(ctx, 1);
  const boss = await owner(ctx);
  assert.equal((await kid.put('/api/admin/links', { links: [] })).status, 403);
  for (const bad of [{}, { links: 'x' }, { links: [{ title: 'x', url: 'javascript:alert(1)' }] }, { links: [{ title: '', url: 'https://a.test' }] },
    { links: [{ title: 'x', url: 'not a url' }] }, { links: Array(101).fill({ title: 'x', url: 'https://a.test' }) }]) {
    assert.equal((await boss.put('/api/admin/links', bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const keep = start[0];
  const r = await boss.put('/api/admin/links', {
    links: [keep, { title: '  Prom tickets ', url: 'https://tickets.example.test/prom', category: '', description: 'x'.repeat(300) }]
  });
  assert.equal(r.status, 200);
  assert.equal(r.data[0].id, keep.id, 'existing ids are kept');
  assert.deepEqual([r.data[1].title, r.data[1].category, r.data[1].description.length], ['Prom tickets', 'Other', 160]);
  assert.equal((await anon.get('/api/links')).data.length, 2);
  assert.equal((await boss.get('/api/admin/backup')).data.links.length, 2);
});

// ---------------------------------------------------------------- profiles

test('profiles: avatar, pronouns and interests; friends see them, others only see the card', async () => {
  const ctx = await startApp({ mock });
  const a = await as(ctx, 1, { given_name: 'Ann', family_name: 'Lee' });
  const b = await as(ctx, 2, { given_name: 'Ben' });
  const c = await as(ctx, 3, { given_name: 'Cy' });
  for (const bad of [{ avatar: 'x' }, { interests: 'chess' }, { interests: Array(11).fill('x') }, { interests: ['a', 'b', 'c', 'd', 'e', 'f'] }, { pronouns: 5 }]) {
    assert.equal((await a.put('/api/me', bad)).status, 400, JSON.stringify(bad));
  }
  const me = (await a.put('/api/me', {
    avatar: { emoji: '🎸', color: 'gold' }, pronouns: ' she/her ', interests: ['Chess', ' chess ', '', 'Band', 'x'.repeat(40)]
  })).data;
  assert.deepEqual(me.avatar, { emoji: '🎸', color: 'gold' });
  assert.equal(me.pronouns, 'she/her');
  assert.deepEqual(me.interests, ['Chess', 'Band', 'x'.repeat(24)]);
  assert.deepEqual((await a.put('/api/me', { avatar: { emoji: '<script>', color: 'chartreuse' } })).data.avatar, { emoji: '', color: 'blue' });
  await a.put('/api/me', { avatar: { emoji: '🎸', color: 'gold' } });

  await befriend(a, b);
  const f = (await b.get('/api/friends')).data.friends[0];
  assert.deepEqual([f.pronouns, f.interests, f.avatar.emoji], ['she/her', ['Chess', 'Band', 'x'.repeat(24)], '🎸']);
  const found = (await c.post('/api/friends/search', { q: 'ann' })).data.results[0];
  assert.deepEqual(found.avatar, { emoji: '🎸', color: 'gold' });
  assert.ok(!('pronouns' in found) && !('interests' in found) && !('bio' in found), 'non-friends see only the card');

  // admin reset clears everything; a lock covers the new fields too
  const boss = await owner(ctx);
  const id = (await a.me()).id;
  const reset = (await boss.put(`/api/admin/users/${id}`, { reset: true, profileLocked: true })).data;
  assert.deepEqual([reset.name, reset.pronouns, reset.interests, reset.avatar], ['Ann L.', '', [], { emoji: '', color: 'blue' }]);
  for (const body of [{ pronouns: 'x' }, { interests: ['x'] }, { avatar: { emoji: '🎸' } }]) {
    assert.equal((await a.put('/api/me', body)).status, 403, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------- people you may know

test('suggestions: friends of friends and classmates, ranked; respects search opt-out and hidden schedules', async () => {
  const ctx = await startApp({ mock });
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const cy = await as(ctx, 3, { given_name: 'Cy' });
  const dee = await as(ctx, 4, { given_name: 'Dee' }); // friends with Ben and Cy
  const eve = await as(ctx, 5, { given_name: 'Eve' }); // friends with Ben
  const fay = await as(ctx, 6, { given_name: 'Fay' }); // in Ann's Math class
  const gus = await as(ctx, 7, { given_name: 'Gus' }); // in Ann's Math class but hides his schedule
  const hal = await as(ctx, 8, { given_name: 'Hal' }); // friends with Ben but not searchable
  await as(ctx, 9, { given_name: 'Ivy' });             // no connection at all
  await befriend(ann, ben); await befriend(ann, cy);
  await befriend(dee, ben); await befriend(dee, cy); await befriend(eve, ben); await befriend(hal, ben);
  await hal.put('/api/me', { searchable: false });
  const math = { yellow: { name: 'Algebra II', teacher: 'Smith' }, red: { name: 'English' } };
  await ann.put('/api/classes', math);
  await fay.put('/api/classes', { yellow: { name: 'algebra ii', teacher: '' } });
  await gus.put('/api/classes', math);
  await gus.put('/api/me', { shareSchedule: false });

  const list = async () => (await ann.get('/api/friends/suggestions')).data.suggestions;
  let s = await list();
  assert.deepEqual(s.map((x) => x.name), ['Dee T.', 'Eve T.', 'Fay T.']);
  assert.deepEqual(s.map((x) => [x.mutual, x.sharedClasses]), [[2, 0], [1, 0], [0, 1]]);
  assert.deepEqual(Object.keys(s[0]).sort(), ['avatar', 'grade', 'id', 'mutual', 'name', 'sharedClasses']);
  assert.ok(!JSON.stringify(s).includes('Algebra'), 'never says which class');

  // a pending request removes them from suggestions; hiding works and is per person
  await ann.post('/api/friends/request', { id: s[1].id });
  assert.equal((await ann.post(`/api/friends/suggestions/${s[2].id}/hide`)).status, 200);
  assert.equal((await ann.post('/api/friends/suggestions/0123456789abcdef/hide')).status, 404);
  s = await list();
  assert.deepEqual(s.map((x) => x.name), ['Dee T.']);
  assert.ok((await cy.get('/api/friends/suggestions')).data.suggestions.some((x) => x.name === 'Ben T.'), "Cy's list is separate");
});
