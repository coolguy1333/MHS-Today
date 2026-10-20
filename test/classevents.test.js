'use strict';
// Classmates' tests, quizzes and assignments: same block, class and teacher only.
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

test('class events: posted to your own class, seen only by the same block, class and teacher', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const cy = await as(ctx, 3, { given_name: 'Cy' });
  const dee = await as(ctx, 4, { given_name: 'Dee' });
  const eli = await as(ctx, 5, { given_name: 'Eli' });
  await ann.put('/api/classes', { yellow: { name: 'Algebra II', teacher: 'Mr. Smith' }, red: { name: 'English' } });
  await ben.put('/api/classes', { yellow: { name: 'algebra  ii', teacher: 'John Smith' } }); // same class, written differently
  await cy.put('/api/classes', { green: { name: 'Algebra II', teacher: 'Smith' } });          // same teacher, other block (other section)
  await dee.put('/api/classes', { yellow: { name: 'Algebra II', teacher: 'Jones' } });         // other teacher
  await eli.put('/api/classes', { yellow: { name: 'Algebra II' } });                           // no teacher: can't tell

  for (const bad of [{}, { block: 'blue', kind: 'quiz', title: 'x', due: soon(2) }, { block: 'yellow', kind: 'essay', title: 'x', due: soon(2) },
    { block: 'yellow', kind: 'quiz', title: ' ', due: soon(2) }, { block: 'yellow', kind: 'quiz', title: 'x', due: soon(-5) }, { block: 'yellow', kind: 'quiz', title: 'x', due: soon(300) }]) {
    assert.equal((await ann.post('/api/classwork', bad)).status, 400, JSON.stringify(bad));
  }
  const noTeacher = await ann.post('/api/classwork', { block: 'red', kind: 'test', title: 'Poems', due: soon(3) });
  assert.equal(noTeacher.status, 400);
  assert.match(noTeacher.data.error, /Add the teacher for English/);

  const quiz = (await ann.post('/api/classwork', { block: 'yellow', kind: 'quiz', title: ' Unit 3 quiz ', due: soon(2), notes: 'Sections 3.1–3.4' })).data;
  assert.deepEqual([quiz.title, quiz.className, quiz.mine, quiz.kind], ['Unit 3 quiz', 'Algebra II', true, 'quiz']);
  assert.equal((await ben.post('/api/classwork', { block: 'yellow', kind: 'quiz', title: 'unit 3 QUIZ', due: soon(2) })).status, 409, 'a classmate already added it');
  await ben.post('/api/classwork', { block: 'yellow', kind: 'test', title: 'Chapter 3 test', due: soon(9) });

  const titles = async (c) => (await c.get('/api/classwork')).data.map((i) => i.title);
  assert.deepEqual(await titles(ann), ['Unit 3 quiz', 'Chapter 3 test'], 'soonest first');
  assert.deepEqual(await titles(ben), ['Unit 3 quiz', 'Chapter 3 test']);
  assert.deepEqual(await titles(cy), [], 'another block is another section');
  assert.deepEqual(await titles(dee), [], 'another teacher');
  assert.deepEqual(await titles(eli), [], 'no teacher, no match');

  assert.equal((await ben.del(`/api/classwork/${quiz.id}`)).status, 403);
  assert.equal((await dee.del(`/api/classwork/${quiz.id}`)).status, 404);

  // in classmates' calendar feeds
  const { url } = (await ben.post('/api/me/calendar')).data;
  const ics = await (await ctx.client().raw('GET', new URL(url).pathname, { xhr: false })).text();
  assert.match(ics, /SUMMARY:Quiz: Unit 3 quiz \(Algebra II\)/);

  // reportable: three classmates hide it
  const more = [];
  for (let n = 6; n <= 8; n++) { const c = await as(ctx, n); await c.put('/api/classes', { yellow: { name: 'Algebra II', teacher: 'Smith' } }); more.push(c); }
  for (const c of more) await c.post('/api/reports', { kind: 'classwork', ref: { id: quiz.id } });
  assert.deepEqual(await titles(ben), ['Chapter 3 test']);
  assert.equal((await ann.get('/api/classwork')).data[0].hidden, true, 'the author still sees it');
  assert.equal((await boss.del(`/api/classwork/${quiz.id}`)).status, 200, 'admins can delete anything');

  // backups keep them
  const backup = (await boss.get('/api/admin/backup')).data;
  assert.deepEqual(backup.classEvents.map((i) => i.title), ['Chapter 3 test']);
});
