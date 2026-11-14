'use strict';
// My to-do list: each student's own, private list.
const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../public/js/calendar.js');
const { startApp, closeAll, user } = require('./helpers');
const { startMockGoogle } = require('./mock-google');

let mock;
test.before(async () => { mock = await startMockGoogle(); });
test.after(async () => { await mock.close(); });
test.afterEach(closeAll);

async function as(ctx, n, extra, opts) {
  const c = ctx.client();
  assert.equal((await c.signIn(mock, user(n, extra), null, opts)).status, 302);
  return c;
}
const day = (n) => cal.addDays(cal.schoolNow('America/Chicago').date, n);

test('to-do list: add, edit, check off, undo, delete; ordered by due date; only its owner sees it', async () => {
  const ctx = await startApp({ mock });
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const boss = await as(ctx, 99, { email: 'admin@school.test' });
  const tea = await as(ctx, 5, { given_name: 'Tee' }, { role: 'teacher' });
  await ann.put('/api/classes', { pink: { name: 'Chemistry', teacher: 'Mole' } });
  assert.equal((await ctx.client().get('/api/todos')).status, 401);
  assert.equal((await tea.get('/api/todos')).status, 403, 'a student feature');
  assert.deepEqual((await ann.get('/api/todos')).data, []);

  for (const bad of [{}, { title: '   ' }, { title: 'x', due: 'tomorrow' }, { title: 'x', due: '2026-02-30' }, { title: 'x', due: '1990-01-01' }, { title: 'x', block: 'red' }, { title: 'x', block: 'nope' }, { title: 'x', done: 'yes' }]) {
    assert.equal((await ann.post('/api/todos', bad)).status, 400, JSON.stringify(bad));
  }
  const later = (await ann.post('/api/todos', { title: '  Read   ch. 4 ', due: day(3), block: 'pink', notes: 'pp. 80-95' })).data;
  assert.deepEqual(later, { id: later.id, title: 'Read ch. 4', due: day(3), block: 'pink', className: 'Chemistry', notes: 'pp. 80-95', done: false });
  const noDate = (await ann.post('/api/todos', { title: 'Permission slip' })).data;
  const sooner = (await ann.post('/api/todos', { title: 'Lab report', due: day(1) })).data;
  assert.equal((await ann.post('/api/todos', { title: 'lab REPORT', due: day(1) })).data.id, sooner.id, 'the same thing twice is kept once');
  assert.deepEqual((await ann.get('/api/todos')).data.map((t) => t.title), ['Lab report', 'Read ch. 4', 'Permission slip'], 'soonest first, no date last');

  // private: nobody else can see, change or delete it; and it isn't in the audit log
  assert.deepEqual((await ben.get('/api/todos')).data, []);
  for (const other of [ben, boss]) {
    assert.equal((await other.put(`/api/todos/${later.id}`, { done: true })).status, 404);
    assert.equal((await other.del(`/api/todos/${later.id}`)).status, 404);
  }
  const log = JSON.stringify((await boss.get('/api/admin/audit')).data);
  assert.match(log, /POST \/api\/todos/);
  assert.doesNotMatch(log, /Read ch\. 4|Permission slip|pp\. 80/);

  // edit some fields, leave the rest
  const edited = (await ann.put(`/api/todos/${later.id}`, { title: 'Read ch. 4 and 5', due: null })).data;
  assert.deepEqual([edited.title, edited.due, edited.block, edited.notes], ['Read ch. 4 and 5', null, 'pink', 'pp. 80-95']);
  assert.equal((await ann.put(`/api/todos/${later.id}`, { title: '' })).status, 400);
  assert.equal((await ann.put('/api/todos/ffffffffffffffff', { done: true })).status, 404);
  // check off: goes to the end; undo puts it back
  assert.equal((await ann.put(`/api/todos/${sooner.id}`, { done: true })).data.done, true);
  assert.deepEqual((await ann.get('/api/todos')).data.map((t) => [t.title, t.done]), [['Read ch. 4 and 5', false], ['Permission slip', false], ['Lab report', true]]); // no date: in the order added
  assert.equal((await ann.put(`/api/todos/${sooner.id}`, { done: false })).data.done, false);
  assert.deepEqual((await ann.del(`/api/todos/${noDate.id}`)).data, { deleted: true });
  assert.equal((await ann.get('/api/todos')).data.length, 2);

  // dropping the class keeps the to-do, without the class
  await ann.put('/api/classes', {});
  assert.deepEqual((await ann.get('/api/todos')).data.map((t) => [t.title, t.block, t.className]), [['Lab report', null, null], ['Read ch. 4 and 5', null, null]]);
});

test('to-do list: on the calendar and in your export; tidied up; kept in backups; gone with the account', async () => {
  const ctx = await startApp({ mock });
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const boss = await as(ctx, 99, { email: 'admin@school.test' });
  const a = (await ann.post('/api/todos', { title: 'Lab report', due: day(1), notes: 'typed' })).data;
  const b = (await ann.post('/api/todos', { title: 'Old thing', due: day(-200) })).data;
  await ann.post('/api/todos', { title: 'No date' });
  const done = (await ann.post('/api/todos', { title: 'Finished', due: day(2) })).data;
  await ann.put(`/api/todos/${done.id}`, { done: true });
  await ben.post('/api/todos', { title: "Ben's own", due: day(1) });

  // calendar page and feed: open ones with a date, only your own
  const items = (await ann.get('/api/me/calendar/items')).data.items.filter((i) => i.kind === 'todo');
  assert.deepEqual(items.map((i) => [i.title, i.date, i.description]), [['To do: Lab report', day(1), 'typed']]);
  const feeds = (await ann.post('/api/me/calendar')).data;
  const classesFeed = await (await fetch(feeds.parts.classes.url)).text();
  assert.match(classesFeed, /SUMMARY:To do: Lab report/);
  assert.doesNotMatch(classesFeed, /Ben's own|Finished|No date/);
  assert.doesNotMatch(await (await fetch(feeds.parts.events.url)).text(), /To do/);
  assert.deepEqual((await ann.get('/api/me/export')).data.todoList.map((t) => [t.title, t.done]).sort(), [['Finished', true], ['Lab report', false], ['No date', false], ['Old thing', false]]);

  // cleanup: long-overdue and long-done ones go; the rest stay
  ctx.app.state.todos.find((t) => t.id === done.id).done = Date.now() - 20 * 86400e3;
  ctx.app.runMaintenance();
  assert.deepEqual((await ann.get('/api/todos')).data.map((t) => t.title), ['Lab report', 'No date']);
  assert.ok(b.id);

  // backups carry them; a restore brings them back, minus junk
  const backup = (await boss.get('/api/admin/backup')).data;
  assert.equal(backup.todos.length, 3);
  await ann.del(`/api/todos/${a.id}`);
  backup.todos.push({ id: 'zz', by: 'nobody', title: 'junk' }, null, { ...backup.todos[0], id: 'aaaaaaaaaaaaaaaa', by: 'ffffffffffffffff' });
  assert.equal((await boss.post('/api/admin/restore', backup)).status, 200);
  assert.deepEqual((await ann.get('/api/todos')).data.map((t) => t.title), ['Lab report', 'No date']);
  assert.equal(ctx.app.state.todos.length, 3);
  assert.equal((await boss.get('/api/admin/status')).data.todos, 3);

  // deleting the account deletes the list
  assert.equal((await ann.del('/api/me')).status, 200);
  assert.deepEqual(ctx.app.state.todos.map((t) => t.title), ["Ben's own"]);
});
