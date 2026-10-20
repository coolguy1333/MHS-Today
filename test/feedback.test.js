'use strict';
// Agreeing to the Privacy & Terms, in-app feedback, and "Download my data".
const test = require('node:test');
const assert = require('node:assert/strict');
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

test('terms: nothing can be changed until you agree; agreeing is remembered and backed up', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const kid = await as(ctx, 1, { given_name: 'Kim' }, { agree: false });
  let me = (await kid.get('/api/me')).data.user;
  assert.equal(me.mustAgree, true);
  assert.match(me.termsVersion, /^\d{4}-\d{2}-\d{2}$/);
  const blocked = await kid.put('/api/classes', { yellow: { name: 'Math' } });
  assert.deepEqual([blocked.status, blocked.data.mustAgree], [403, true]);
  assert.equal((await kid.get('/api/events')).status, 200, 'reading is fine');
  assert.equal((await kid.post('/api/me/agree', { version: '1999-01-01' })).status, 400, 'only the current version');
  assert.equal((await kid.post('/api/me/agree', { version: me.termsVersion })).data.mustAgree, false);
  assert.equal((await kid.put('/api/classes', { yellow: { name: 'Math' } })).status, 200);
  // a restore keeps who agreed
  const backup = (await boss.get('/api/admin/backup')).data;
  assert.equal(backup.users.find((u) => u.email === 'user1@school.test').agreed.version, me.termsVersion);
  await boss.post('/api/admin/restore', backup);
  me = (await kid.get('/api/me')).data.user;
  assert.equal(me.mustAgree, false);
  // someone who hasn't agreed can still sign out or delete their account
  const shy = await as(ctx, 2, {}, { agree: false });
  assert.equal((await shy.del('/api/me')).status, 200);
});

test('feedback: sent by students, answered by admins in the app, kept private', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const kim = await as(ctx, 1, { given_name: 'Kim' });
  const lee = await as(ctx, 2, { given_name: 'Lee' });
  for (const bad of [{ message: 'The lunch page is blank' }, { type: 'rant', message: 'hello there' }, { type: 'bug', message: ' ' }]) {
    assert.equal((await kim.post('/api/feedback', bad)).status, 400, JSON.stringify(bad));
  }
  const sent = (await kim.post('/api/feedback', { type: 'bug', message: '  The lunch page\n\n\n\nis blank  ', page: '/lunch.html' })).data;
  assert.deepEqual([sent.status, sent.message, sent.replies], ['new', 'The lunch page\n\nis blank', []]);
  await lee.post('/api/feedback', { type: 'idea', message: 'Add a dark mode toggle', page: 'javascript:alert(1)' });
  assert.equal((await lee.get('/api/feedback')).data.length, 1, 'you only see your own');
  assert.equal((await kim.get('/api/admin/feedback')).status, 403);

  const inbox = (await boss.get('/api/admin/feedback')).data;
  assert.deepEqual(inbox.map((f) => [f.type, f.from.name, f.from.email, f.page]), [['idea', 'Lee T.', 'user2@school.test', ''], ['bug', 'Kim T.', 'user1@school.test', '/lunch.html']]);
  assert.equal((await boss.get('/api/admin/status')).data.feedbackNew, 2);
  assert.equal((await boss.put(`/api/admin/feedback/${sent.id}`, { status: 'closed' })).status, 400);
  assert.equal((await boss.post(`/api/admin/feedback/${sent.id}/reply`, { text: 'Fixed! Thanks Kim.' })).status, 200);
  assert.equal((await kim.get('/api/me')).data.user.unreadFeedback, 1);
  const mine = (await kim.get('/api/feedback')).data;
  assert.deepEqual([mine[0].status, mine[0].replies[0].text, mine[0].replies[0].by, mine[0].unread], ['seen', 'Fixed! Thanks Kim.', 'Ada T.', true]);
  assert.equal((await kim.get('/api/me')).data.user.unreadFeedback, 0, 'reading the page marks it read');
  await boss.put(`/api/admin/feedback/${sent.id}`, { status: 'done' });
  assert.equal((await boss.get('/api/admin/feedback')).data.find((f) => f.id === sent.id).status, 'done');

  // "Download my data" has your feedback (and only yours)
  const exp = await kim.get('/api/me/export');
  assert.match(exp.headers.get('content-disposition'), /my-mhs-today-data\.json/);
  assert.equal(exp.data.account.email, 'user1@school.test');
  assert.deepEqual(exp.data.feedback.map((f) => f.message), ['The lunch page\n\nis blank']);
  assert.equal(exp.data.account.mustAgree, false);

  // backups keep feedback; deleting your account removes yours
  const backup = (await boss.get('/api/admin/backup')).data;
  assert.equal(backup.feedback.length, 2);
  await lee.del('/api/me');
  assert.equal((await boss.get('/api/admin/feedback')).data.length, 1);
  assert.equal((await boss.del(`/api/admin/feedback/${sent.id}`)).status, 200);
  assert.equal((await boss.get('/api/admin/feedback')).data.length, 0);
});
