'use strict';
// Classmates' tests, quizzes and assignments: same class and teacher (any block) only.
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

test('class events: posted to your own class, seen by the same class and teacher in any block', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const cy = await as(ctx, 3, { given_name: 'Cy' });
  const dee = await as(ctx, 4, { given_name: 'Dee' });
  const eli = await as(ctx, 5, { given_name: 'Eli' });
  await ann.put('/api/classes', { yellow: { name: 'Algebra II', teacher: 'Mr. Smith' }, red: { name: 'English' } });
  await ben.put('/api/classes', { yellow: { name: 'algebra  ii', teacher: 'John Smith' } }); // same class, written differently
  await cy.put('/api/classes', { green: { name: 'Algebra II', teacher: 'Smith' } });          // same class and teacher, another hour
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
  assert.deepEqual(await titles(cy), ['Unit 3 quiz', 'Chapter 3 test'], 'the same class in another block sees it too');
  assert.ok((await cy.get('/api/classwork')).data.every((i) => i.block === 'green'), 'shown under Cy\'s own block');
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

test('study sessions: everyone in the same class sees them, whatever block they have it in', async () => {
  const ctx = await startApp({ mock });
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const cy = await as(ctx, 3, { given_name: 'Cy' });
  await ann.put('/api/classes', { orange: { name: 'AP Calculus AB', teacher: 'Simmonds' } });
  await ben.put('/api/classes', { red: { name: 'AP Calculus AB', teacher: 'Jacob Simmonds' } }); // another hour
  await cy.put('/api/classes', { orange: { name: 'Chemistry', teacher: 'Mole' } });            // same block, other class
  assert.equal((await ann.post('/api/study', { block: 'orange', title: 'Unit 3 review', date: soon(2) })).status, 200);
  assert.deepEqual((await ben.get('/api/study')).data.map((s) => [s.title, s.block]), [['Unit 3 review', 'red']]);
  assert.deepEqual((await cy.get('/api/study')).data, []);
});

test('old assignments and study sessions clear once their day is over', async () => {
  const ctx = await startApp({ mock });
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  await ann.put('/api/classes', { yellow: { name: 'Algebra II', teacher: 'Smith' } });
  await ann.post('/api/classwork', { block: 'yellow', kind: 'quiz', title: 'Today quiz', due: soon(0) });
  await ann.post('/api/classwork', { block: 'yellow', kind: 'test', title: 'Next week test', due: soon(7) });
  await ann.post('/api/study', { block: 'yellow', title: 'Review', date: soon(0) });
  // a day passes: what was due "today" is now yesterday's
  for (const i of ctx.app.state.classEvents) if (i.title === 'Today quiz') i.due = soon(-1);
  for (const s of ctx.app.state.studySessions) s.date = soon(-1);
  assert.deepEqual((await ann.get('/api/classwork')).data.map((i) => i.title), ['Next week test'], 'hidden straight away');
  assert.deepEqual((await ann.get('/api/study')).data, []);
  ctx.app.runMaintenance();
  assert.deepEqual(ctx.app.state.classEvents.map((i) => i.title), ['Next week test'], 'and removed by the cleanup');
  assert.deepEqual(ctx.app.state.studySessions, []);
});

test('editing: the person who added a test (or an admin) can fix it without deleting it', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  for (const c of [ann, ben]) await c.put('/api/classes', { yellow: { name: 'Algebra II', teacher: 'Smith' } });
  const q = (await ann.post('/api/classwork', { block: 'yellow', kind: 'quiz', title: 'Unit 3 quiz', due: soon(2) })).data;
  assert.equal((await ben.put(`/api/classwork/${q.id}`, { kind: 'test', title: 'x', due: soon(3) })).status, 403, 'not theirs');
  assert.equal((await ann.put(`/api/classwork/${q.id}`, { kind: 'quiz', title: '', due: soon(3) })).status, 400);
  const fixed = (await ann.put(`/api/classwork/${q.id}`, { kind: 'test', title: 'Unit 3 test', due: soon(4), notes: 'Moved to Friday' })).data;
  assert.deepEqual([fixed.id, fixed.kind, fixed.title, fixed.due, fixed.notes], [q.id, 'test', 'Unit 3 test', soon(4), 'Moved to Friday']);
  assert.deepEqual((await ben.get('/api/classwork')).data.map((i) => i.title), ['Unit 3 test'], 'classmates see the change');
  assert.equal((await boss.put(`/api/classwork/${q.id}`, { kind: 'test', title: 'Unit 3 test (fixed)', due: soon(4) })).status, 200, 'admins can fix anything (as they can delete it)');
  assert.deepEqual((await ann.get('/api/classwork')).data.map((i) => i.title), ['Unit 3 test (fixed)']);
});
