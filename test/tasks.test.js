'use strict';
// Assignments = each person's own Google Tasks: connecting, the tokens, and the Tasks API proxy.
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
test.afterEach(() => { mock.grantScope = null; mock.noRefreshToken = false; mock.denyNext = false; return closeAll(); });

async function as(ctx, n, extra) {
  const c = ctx.client();
  assert.equal((await c.signIn(mock, user(n, extra))).status, 302);
  return c;
}
const owner = (ctx) => as(ctx, 99, { email: 'admin@school.test', given_name: 'Ada' });
const where = (r) => r.headers.get('location');
const day = (n) => cal.addDays(cal.schoolNow('America/Chicago').date, n);

test('tasks: connect asks for the Tasks scope with offline access, for your own account only', async () => {
  const ctx = await startApp({ mock });
  assert.equal(where(await ctx.client().raw('GET', '/auth/google?connect=tasks')), '/login.html?next=classwork.html', 'sign in first');
  const ann = await as(ctx, 1);
  assert.deepEqual((await ann.get('/api/tasks')).data, { available: true, connected: false });
  assert.equal((await ann.post('/api/tasks', { title: 'x' })).status, 409, 'not connected yet');

  const r = await ann.connectTasks(mock);
  assert.equal(where(r), '/classwork.html?tasks=connected');
  const q = mock.lastAuthQuery;
  assert.deepEqual([q.scope, q.access_type, q.prompt, q.login_hint], ['openid email https://www.googleapis.com/auth/tasks', 'offline', 'consent', 'user1@school.test']);
  assert.equal((await ann.get('/api/tasks')).data.connected, true);
  assert.equal((await ann.get('/api/me')).data.user.googleTasks, undefined, 'tokens never go to the browser');

  // the refresh token is stored encrypted, never as plain text
  ctx.app.db.flush();
  const db = fs.readFileSync(path.join(ctx.dataDir, 'db.json'), 'utf8');
  const stored = JSON.parse(db).users[(await ann.me()).id].googleTasks.token;
  assert.match(stored, /^v1\./);
  assert.ok(!/refresh-\d+-/.test(db));
  assert.equal(fs.statSync(path.join(ctx.dataDir, 'secret.key')).mode & 0o077, 0, 'the key file is private');

  // a different Google account at the consent screen is refused (and its token revoked)
  const ben = await as(ctx, 2);
  const before = mock.revoked.length;
  assert.equal(where(await ben.connectTasks(mock, user(3))), '/classwork.html?tasks=account');
  await new Promise((res) => setTimeout(res, 50)); // revoking doesn't hold up the redirect
  assert.equal(mock.revoked.length, before + 1);
  assert.equal((await ben.get('/api/tasks')).data.connected, false);
});

test('tasks: unticked box, no refresh token, cancelled, or a stolen callback all fail cleanly', async () => {
  const ctx = await startApp({ mock });
  const ann = await as(ctx, 1);
  mock.grantScope = 'openid email';
  assert.equal(where(await ann.connectTasks(mock)), '/classwork.html?tasks=scope');
  mock.grantScope = null;
  mock.noRefreshToken = true;
  assert.equal(where(await ann.connectTasks(mock)), '/classwork.html?tasks=offline');
  mock.noRefreshToken = false;
  mock.denyNext = true;
  assert.equal(where(await ann.connectTasks(mock)), '/classwork.html?tasks=denied');
  assert.equal((await ann.get('/api/tasks')).data.connected, false);

  // a callback started by Ann can't be finished in someone else's browser session
  const start = await ann.raw('GET', '/auth/google?connect=tasks');
  const cb = new URL((await fetch(where(start), { redirect: 'manual' })).headers.get('location'));
  const ben = await as(ctx, 2);
  ben.jar.set('mhs_login', ann.jar.get('mhs_login'));
  const r = await ben.raw('GET', cb.pathname + cb.search);
  assert.equal(where(r), '/classwork.html?tasks=signin');
  assert.equal((await ben.get('/api/tasks')).data.connected, false);
  assert.equal((await ann.get('/api/tasks')).data.connected, false);

  // plain sign-in still asks only for the basics
  await ctx.client().signIn(mock, user(4));
  assert.equal(mock.lastAuthQuery.scope, 'openid email profile');
  assert.equal(mock.lastAuthQuery.access_type, undefined);
});

test('tasks: list, add and check off your Google Tasks; others never see them', async () => {
  const ctx = await startApp({ mock });
  const ann = await as(ctx, 1);
  const ben = await as(ctx, 2);
  await ann.connectTasks(mock, user(1));
  mock.tasksOf('sub-1').push({ id: 'list-chem', title: 'Chemistry', items: [] });
  mock.addTask('sub-1', { title: 'Lab report', due: `${day(3)}T00:00:00.000Z` }, 'list-chem');
  mock.addTask('sub-1', { title: 'Read ch. 4' });
  mock.addTask('sub-1', { title: 'Old', status: 'completed' });
  mock.addTask('sub-1', { title: 'Sneaky', webViewLink: 'javascript:alert(1)', due: `${day(1)}T00:00:00.000Z` });

  let r = (await ann.get('/api/tasks')).data;
  assert.deepEqual(r.lists.map((l) => l.title), ['My Tasks', 'Chemistry']);
  assert.deepEqual(r.tasks.map((t) => [t.title, t.list, t.due]), [['Sneaky', 'My Tasks', day(1)], ['Lab report', 'Chemistry', day(3)], ['Read ch. 4', 'My Tasks', null]], 'soonest first, undated last, done ones hidden');
  assert.equal(r.tasks[0].link, null, 'only Google Tasks links');
  assert.match(r.tasks[1].link, /^https:\/\/tasks\.google\.com\//);
  assert.deepEqual((await ben.get('/api/tasks')).data, { available: true, connected: false });

  for (const bad of [{ title: ' ' }, { title: 'x', due: 'Friday' }, { title: 'x', listId: '../x' }]) {
    assert.equal((await ann.post('/api/tasks', bad)).status, 400, JSON.stringify(bad));
  }
  const added = (await ann.post('/api/tasks', { title: ' Unit 3 quiz ', due: day(2), notes: 'Sections 3.1-3.4' })).data;
  assert.deepEqual([added.title, added.due], ['Unit 3 quiz', day(2)]);
  const inGoogle = mock.tasksOf('sub-1')[0].items.find((t) => t.title === 'Unit 3 quiz');
  assert.deepEqual([inGoogle.due, inGoogle.notes], [`${day(2)}T00:00:00.000Z`, 'Sections 3.1-3.4']);
  assert.equal((await ann.post('/api/tasks', { title: 'Poster', listId: 'list-chem' })).status, 200);
  assert.ok(mock.tasksOf('sub-1')[1].items.some((t) => t.title === 'Poster'));

  const lab = r.tasks[1];
  assert.equal((await ann.put(`/api/tasks/${lab.listId}/${lab.id}`, { done: 'yes' })).status, 400);
  assert.equal((await ann.put(`/api/tasks/${lab.listId}/${lab.id}`, { done: true })).status, 200);
  assert.equal(mock.tasksOf('sub-1')[1].items.find((t) => t.id === lab.id).status, 'completed');
  r = (await ann.get('/api/tasks')).data;
  assert.ok(!r.tasks.some((t) => t.id === lab.id));
  assert.equal((await ann.put(`/api/tasks/${lab.listId}/${lab.id}`, { done: false })).status, 200, 'undo');
  assert.equal(mock.tasksOf('sub-1')[1].items.find((t) => t.id === lab.id).status, 'needsAction');
  assert.equal((await ann.put(`/api/tasks/${lab.listId}/nope`, { done: true })).status, 404);
  assert.equal((await ben.put(`/api/tasks/${lab.listId}/${lab.id}`, { done: true })).status, 409, "Ben can't touch Ann's tasks");

  // an expired access token is refreshed without bothering anyone
  mock.expireAccessTokens();
  assert.equal((await ann.get('/api/tasks')).data.tasks.length, 5);
});

test('tasks: disconnecting or revoking at Google forgets the token; deleting your account revokes it', async () => {
  const ctx = await startApp({ mock });
  const ann = await as(ctx, 1);
  await ann.connectTasks(mock);
  const before = mock.revoked.length;
  assert.equal((await ann.del('/api/tasks/connection')).status, 200);
  assert.equal(mock.revoked.length, before + 1, 'Google is told to forget it');
  assert.equal((await ann.get('/api/tasks')).data.connected, false);
  assert.equal(ctx.app.state.users[(await ann.me()).id].googleTasks, undefined);

  // removed from the Google account's settings: the next call says to connect again
  await ann.connectTasks(mock);
  mock.revokeAll('sub-1');
  const r = await ann.get('/api/tasks');
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Connect it again/);
  assert.equal((await ann.get('/api/tasks')).data.connected, false);

  await ann.connectTasks(mock);
  const n = mock.revoked.length;
  await ann.del('/api/me');
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(mock.revoked.length, n + 1);
});

test('tasks: never in backups; a restore on the same server keeps connections', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1);
  await ann.connectTasks(mock, user(1));
  mock.addTask('sub-1', { title: 'Still here' });
  const backup = (await boss.get('/api/admin/backup')).data;
  assert.ok(!JSON.stringify(backup).includes('googleTasks'));
  assert.equal((await boss.post('/api/admin/restore', backup)).status, 200);
  assert.ok((await ann.get('/api/tasks')).data.tasks.some((t) => t.title === 'Still here'));

  const other = await startApp({ mock });
  await (await owner(other)).post('/api/admin/restore', backup);
  const ann2 = await as(other, 1);
  assert.equal((await ann2.get('/api/tasks')).data.connected, false, 'another server: connect again');
});

test('tasks: off when Google sign-in is not set up', async () => {
  const ctx = await startApp({ mock, tweak: (c) => { c.google.clientId = ''; } });
  // no sign-in means no session either, so just check the route answers safely
  assert.equal((await ctx.client().get('/api/tasks')).status, 401);
  assert.equal(where(await ctx.client().raw('GET', '/auth/google?connect=tasks')), '/login.html?error=config');
});
