'use strict';
// Name search, per-friend sharing levels, profiles and admin profile editing.
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
const admin = (ctx) => as(ctx, 99, { email: 'admin@school.test', given_name: 'Ada', family_name: 'Min' });
async function befriend(a, b) {
  await a.post('/api/friends/request', { code: (await b.me()).friendCode });
  await b.post('/api/friends/request', { code: (await a.me()).friendCode });
}
const search = async (c, q) => (await c.post('/api/friends/search', { q })).data.results.map((r) => r.name);

// ---------------------------------------------------------------- name search

test('search: by first or last name, partial and in any order, accents ignored; only the display name comes back', async () => {
  const ctx = await startApp({ mock });
  const me = await as(ctx, 1, { given_name: 'Ann', family_name: 'Lee' });
  await as(ctx, 2, { given_name: 'José', family_name: "O'Neil-Martínez" });
  await as(ctx, 3, { given_name: 'Joseph', family_name: 'Smith' });
  await as(ctx, 4, { given_name: 'Sam', family_name: 'Josephson' });
  await as(ctx, 5, { given_name: undefined, family_name: undefined, name: 'Kim Van Der Berg' });

  assert.deepEqual(await search(me, 'jose'), ['José O.', 'Joseph S.', 'Sam J.']);
  assert.deepEqual(await search(me, 'Jose Smith'), ['Joseph S.']);
  assert.deepEqual(await search(me, 'smith joseph'), ['Joseph S.']);
  assert.deepEqual(await search(me, 'oneil'), ['José O.']);
  assert.deepEqual(await search(me, 'martinez jose'), ['José O.']);
  assert.deepEqual(await search(me, 'van berg'), ['Kim V.']);
  assert.deepEqual(await search(me, 'ann'), [], 'you are not in your own results');
  assert.deepEqual(await search(me, 'zzz'), []);

  const r = (await me.post('/api/friends/search', { q: 'joseph smith' })).data;
  assert.deepEqual(Object.keys(r.results[0]).sort(), ['grade', 'id', 'name', 'status']);
  const text = JSON.stringify(r);
  assert.ok(!text.includes('Smith') && !text.includes('@'), 'no full last name or email');

  for (const q of ['', 'a', ' . ', 5, null]) assert.equal((await me.post('/api/friends/search', { q })).status, 400, String(q));
});

test('search: people can opt out, and the status shows requests and friendships', async () => {
  const ctx = await startApp({ mock });
  const a = await as(ctx, 1, { given_name: 'Ann', family_name: 'Lee' });
  const b = await as(ctx, 2, { given_name: 'Ben', family_name: 'Lee' });
  const c = await as(ctx, 3, { given_name: 'Cy', family_name: 'Lee' });
  assert.equal((await b.me()).searchable, true, 'searchable unless they opt out');
  assert.equal((await c.put('/api/me', { searchable: 'no' })).status, 400);
  assert.equal((await c.put('/api/me', { searchable: false })).data.searchable, false);
  assert.deepEqual(await search(a, 'lee'), ['Ben L.']);

  const ben = (await a.post('/api/friends/search', { q: 'ben' })).data.results[0];
  assert.equal(ben.status, null);
  assert.deepEqual((await a.post('/api/friends/request', { id: ben.id })).data, { status: 'requested', name: 'Ben L.' });
  assert.equal((await a.post('/api/friends/search', { q: 'ben' })).data.results[0].status, 'requested');
  assert.equal((await b.post('/api/friends/search', { q: 'ann' })).data.results[0].status, 'incoming');
  assert.equal((await b.post('/api/friends/request', { id: (await a.me()).id })).data.status, 'friends');
  assert.equal((await a.post('/api/friends/search', { q: 'ben' })).data.results[0].status, 'friends');

  // requests by id only reach searchable people (or someone who already asked you)
  const cyId = (await c.me()).id;
  assert.equal((await a.post('/api/friends/request', { id: cyId })).status, 404);
  assert.equal((await a.post('/api/friends/request', { id: '0123456789abcdef' })).status, 404);
  assert.equal((await a.post('/api/friends/request', { id: (await a.me()).id })).status, 400, "can't befriend yourself");
  await c.post('/api/friends/request', { code: (await a.me()).friendCode });
  assert.equal((await a.post('/api/friends/request', { id: cyId })).data.status, 'friends', 'answering their request works');
});

test('search: throttled per person', async () => {
  const ctx = await startApp({ mock });
  const a = await as(ctx, 1);
  let limited = 0;
  for (let i = 0; i < 125; i++) if ((await a.post('/api/friends/search', { q: 'xx' })).status === 429) limited++;
  assert.ok(limited >= 5);
});

// ---------------------------------------------------------------- sharing levels

test('levels: each person picks per friend: classes + lunch, lunch only, or nothing', async () => {
  const ctx = await startApp({ mock });
  const a = await as(ctx, 1, { given_name: 'Ann' });
  const b = await as(ctx, 2, { given_name: 'Ben' });
  await a.put('/api/classes', { yellow: { name: 'Math' }, green: { name: 'Bio', lunch: 'A' }, orange: { name: 'Gym', lunch: 'C' } });
  await befriend(a, b);
  const annId = (await a.me()).id, benId = (await b.me()).id;
  const annSeenByBen = async () => (await b.get('/api/friends')).data.friends[0];

  let f = await annSeenByBen();
  assert.equal(f.level, 'full'); assert.equal(f.classes.yellow.name, 'Math'); assert.equal(f.lunches, null);
  assert.equal((await a.get('/api/friends')).data.friends[0].myLevel, 'full');

  assert.equal((await a.put(`/api/friends/${benId}`, { level: 'lunch' })).status, 200);
  f = await annSeenByBen();
  assert.equal(f.level, 'lunch'); assert.equal(f.classes, null);
  assert.deepEqual(f.lunches, { A: 'A', B: 'C', C: 'C', D: 'C' });
  assert.ok(!JSON.stringify(f).includes('Math'));
  assert.equal((await a.get('/api/friends')).data.friends[0].myLevel, 'lunch');

  await a.put(`/api/friends/${benId}`, { level: 'none' });
  f = await annSeenByBen();
  assert.equal(f.level, 'none'); assert.equal(f.classes, null); assert.equal(f.lunches, null);
  assert.equal((await a.get('/api/friends')).data.friends[0].level, 'full', "Ann's choice doesn't change what Ben shares");

  // the Account master switch overrides every level
  await a.put(`/api/friends/${benId}`, { level: 'full' });
  await a.put('/api/me', { shareSchedule: false });
  assert.equal((await annSeenByBen()).level, 'none');
  await a.put('/api/me', { shareSchedule: true });
  assert.equal((await annSeenByBen()).level, 'full');

  for (const level of ['all', '', null, undefined]) assert.equal((await a.put(`/api/friends/${benId}`, { level })).status, 400, String(level));
  assert.equal((await a.put('/api/friends/0123456789abcdef', { level: 'none' })).status, 404);

  // unfriending forgets the level, so a new friendship starts fresh
  await a.put(`/api/friends/${benId}`, { level: 'none' });
  await b.del(`/api/friends/${annId}`);
  await befriend(a, b);
  assert.equal((await annSeenByBen()).level, 'full');
});

// ---------------------------------------------------------------- profiles

test('profile: grade and bio, validated, shown to friends', async () => {
  const ctx = await startApp({ mock });
  const a = await as(ctx, 1, { given_name: 'Ann' });
  const b = await as(ctx, 2, { given_name: 'Ben' });
  for (const bad of [{ grade: 8 }, { grade: 13 }, { grade: 'ten' }, { grade: 10.5 }, { bio: 5 }, { name: '  ' }]) {
    assert.equal((await a.put('/api/me', bad)).status, 400, JSON.stringify(bad));
  }
  const me = (await a.put('/api/me', { grade: '11', bio: '  Band, robotics‮ and   chess ' + 'x'.repeat(300) })).data;
  assert.equal(me.grade, 11);
  assert.equal(Array.from(me.bio).length, 160); assert.match(me.bio, /^Band, robotics and chess x/);
  assert.equal((await a.put('/api/me', { grade: null })).data.grade, null);
  await a.put('/api/me', { grade: 12 });
  await befriend(a, b);
  const f = (await b.get('/api/friends')).data.friends[0];
  assert.equal(f.grade, 12); assert.match(f.bio, /^Band/);
  assert.equal((await b.post('/api/friends/search', { q: 'ann' })).data.results[0].grade, 12);
});

test('admin: edits, resets and locks profiles; students cannot', async () => {
  const ctx = await startApp({ mock });
  const boss = await admin(ctx);
  const kid = await as(ctx, 1, { given_name: 'Kim', family_name: 'Tran' });
  const other = await as(ctx, 2);
  const id = (await kid.me()).id;
  await kid.put('/api/me', { name: 'xX_Kim_Xx', grade: 10, bio: 'something rude' });

  const row = (await boss.get('/api/admin/users')).data.find((u) => u.id === id);
  assert.equal(row.fullName, 'Kim Tran'); assert.equal(row.bio, 'something rude'); assert.equal(row.profileLocked, false); assert.equal(row.searchable, true);

  assert.equal((await other.put(`/api/admin/users/${id}`, { bio: '' })).status, 403);
  assert.equal((await boss.put(`/api/admin/users/${id}`, {})).status, 400);
  assert.equal((await boss.put(`/api/admin/users/${id}`, { grade: 7 })).status, 400);
  assert.equal((await boss.put(`/api/admin/users/${id}`, { reset: 'yes' })).status, 400);
  assert.equal((await boss.put(`/api/admin/users/${id}`, { profileLocked: 1 })).status, 400);

  const edited = (await boss.put(`/api/admin/users/${id}`, { bio: '', name: 'Kim T.' })).data;
  assert.equal(edited.bio, ''); assert.equal(edited.name, 'Kim T.'); assert.equal(edited.grade, 10);
  await kid.put('/api/me', { name: 'again', bio: 'again' });
  const reset = (await boss.put(`/api/admin/users/${id}`, { reset: true, profileLocked: true })).data;
  assert.deepEqual([reset.name, reset.grade, reset.bio, reset.profileLocked], ['Kim T.', null, '', true]);
  assert.ok(ctx.logs.some((l) => new RegExp(`User ${id} profile reset by admin`).test(l)));

  // locked: the student can't change name/grade/bio, but privacy switches still work
  assert.equal((await kid.me()).profileLocked, true);
  for (const b of [{ name: 'x' }, { grade: 9 }, { bio: 'x' }]) assert.equal((await kid.put('/api/me', b)).status, 403, JSON.stringify(b));
  assert.equal((await kid.put('/api/me', { searchable: false, shareSchedule: false })).status, 200);
  assert.equal((await boss.put(`/api/admin/users/${id}`, { profileLocked: false })).status, 200);
  assert.equal((await kid.put('/api/me', { bio: 'ok now' })).data.bio, 'ok now');
});

test('backup keeps profiles, search choice and sharing levels', async () => {
  const one = await startApp({ mock });
  const boss = await admin(one);
  const a = await as(one, 1, { given_name: 'Ann', family_name: 'Lee' });
  const b = await as(one, 2, { given_name: 'Ben' });
  await befriend(a, b);
  await a.put('/api/me', { grade: 9, bio: 'hi', searchable: false });
  await a.put(`/api/friends/${(await b.me()).id}`, { level: 'lunch' });
  await boss.put(`/api/admin/users/${(await a.me()).id}`, { profileLocked: true });
  const backup = (await boss.get('/api/admin/backup')).data;
  backup.users.find((u) => u.givenName === 'Ann').shareLevels.bogus = 'none';

  const two = await startApp({ mock });
  const boss2 = await admin(two);
  assert.equal((await boss2.post('/api/admin/restore', backup)).status, 200);
  const ann = Object.values(two.app.state.users).find((u) => u.givenName === 'Ann');
  assert.deepEqual([ann.familyName, ann.grade, ann.bio, ann.searchable, ann.profileLocked], ['Lee', 9, 'hi', false, true]);
  assert.deepEqual(Object.values(ann.shareLevels), ['lunch']);
  assert.ok(!('bogus' in ann.shareLevels));
});
