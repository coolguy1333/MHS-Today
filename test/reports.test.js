'use strict';
// Reporting what other people post, and the admins' review queue.
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
const soon = (n) => cal.addDays(cal.schoolNow('America/Chicago').date, n);

test('reports: three people hide something; its author and admins still see it; admins keep or remove it', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const kids = [];
  for (let n = 1; n <= 5; n++) kids.push(await as(ctx, n, { given_name: `Kid${n}` }));
  const [ann, ...others] = kids;
  const ev = (await ann.post('/api/events', { title: 'Rude party', date: soon(2) })).data.id;
  assert.equal((await ann.post('/api/reports', { kind: 'event', ref: { id: ev } })).status, 400, 'not your own');
  assert.equal((await others[0].post('/api/reports', { kind: 'nope', ref: {} })).status, 400);
  assert.equal((await others[0].post('/api/reports', { kind: 'event', ref: { id: 'ffffffffffffffff' } })).status, 404);
  assert.equal((await others[0].post('/api/reports', { kind: 'event', ref: { id: ev }, reason: 'mean', note: 'not nice' })).data.hidden, false);
  assert.equal((await others[0].post('/api/reports', { kind: 'event', ref: { id: ev } })).data.already, true, 'one report per person');
  await others[1].post('/api/reports', { kind: 'event', ref: { id: ev }, reason: 'spam' });
  assert.equal((await others[2].post('/api/reports', { kind: 'event', ref: { id: ev } })).data.hidden, true);
  const seen = async (c) => (await c.get('/api/events')).data.find((e) => e.id === ev);
  assert.equal(await seen(others[3]), undefined, 'hidden from everyone else');
  assert.equal((await seen(ann)).hidden, true, 'the author still sees it, marked hidden');
  assert.equal((await seen(boss)).hidden, true);

  assert.equal((await ann.get('/api/admin/reports')).status, 403);
  let q = (await boss.get('/api/admin/reports')).data;
  assert.equal(q.open.length, 1);
  assert.deepEqual([q.open[0].kind, q.open[0].summary, q.open[0].author.name, q.open[0].reports.map((r) => r.reason)], ['event', 'Rude party', 'Kid1 T.', ['mean', 'spam', 'other']]);
  assert.equal((await boss.get('/api/admin/status')).data.reportsOpen, 1);
  assert.equal((await boss.post(`/api/admin/reports/${q.open[0].id}/keep`)).status, 200);
  assert.ok(await seen(others[3]), 'kept: visible again');
  assert.equal((await boss.post(`/api/admin/reports/${q.open[0].id}/keep`)).status, 404, 'already handled');
  // reported again later: a new report; this time it's removed
  await others[3].post('/api/reports', { kind: 'event', ref: { id: ev } });
  q = (await boss.get('/api/admin/reports')).data;
  assert.equal(q.done.length, 1);
  await boss.post(`/api/admin/reports/${q.open[0].id}/remove`);
  assert.equal(await seen(ann), undefined, 'removed for good');
});

test('reports: group posts, replies and polls (members only), study sessions, and profiles (reset, never hidden)', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const lead = await as(ctx, 1, { given_name: 'Lea' });
  const mems = [];
  for (let n = 2; n <= 5; n++) mems.push(await as(ctx, n));
  const outsider = await as(ctx, 6);
  const gid = (await lead.post('/api/groups', { name: 'Chess', kind: 'club', joinPolicy: 'open' })).data.id;
  await boss.put(`/api/admin/groups/${gid}`, { approved: true });
  for (const m of mems) await m.post(`/api/groups/${gid}/join`);
  let board = (await mems[0].post(`/api/groups/${gid}/posts`, { text: 'mean words' })).data;
  const post = board.posts[0].id;
  board = (await mems[1].post(`/api/groups/${gid}/posts/${post}/replies`, { text: 'meaner reply' })).data;
  const reply = board.posts[0].replies[0].id;
  assert.equal((await outsider.post('/api/reports', { kind: 'post', ref: { group: gid, id: post } })).status, 404, 'only people who can see it');
  for (const m of [lead, mems[1], mems[2]]) await m.post('/api/reports', { kind: 'post', ref: { group: gid, id: post } });
  for (const m of [lead, mems[0], mems[2]]) await m.post('/api/reports', { kind: 'reply', ref: { group: gid, post, id: reply } });
  assert.equal((await mems[3].get(`/api/groups/${gid}/board`)).data.posts.length, 0, 'hidden post (and its replies) for other members');
  const mine = (await mems[0].get(`/api/groups/${gid}/board`)).data.posts;
  assert.deepEqual([mine[0].hidden, mine[0].mine, mine[0].replies.length], [true, true, 0], 'the author sees their hidden post; the hidden reply is not theirs');

  // profiles: reported, never hidden; "remove" resets it
  await mems[3].put('/api/me', { bio: 'something rude', pronouns: 'x' });
  const target = (await mems[3].me()).id;
  for (const m of [mems[0], mems[1], mems[2]]) assert.equal((await m.post('/api/reports', { kind: 'profile', ref: { id: target }, reason: 'inappropriate' })).data.hidden, false);
  const q = (await boss.get('/api/admin/reports')).data.open;
  const prof = q.find((r) => r.kind === 'profile');
  assert.match(prof.summary, /something rude/);
  await boss.post(`/api/admin/reports/${prof.id}/remove`);
  const after = await mems[3].me();
  assert.deepEqual([after.bio, after.pronouns, after.name], ['', '', 'User5 T.']);

  // deleting your account takes your reports and the reports about your things with it
  await mems[0].del('/api/me');
  assert.ok(!(await boss.get('/api/admin/reports')).data.open.some((r) => r.kind === 'post'));
});
