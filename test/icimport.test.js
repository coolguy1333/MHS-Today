'use strict';
// Reading a schedule copied from Infinite Campus, and matching classes by teacher last name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, teacherName } = require('../public/js/icimport.js');
const bell = require('../public/js/bellSchedule.js');

// The layout of a real copied schedule (names changed): bullets, [links](…), "Period Blue~",
// Advisory periods, a lunch line on the Hour 4 classes, and the same classes repeated per day.
const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ic-schedule.txt'), 'utf8');

test('import: every color block, teacher as First Last, room, and lunch on the Hour 4 classes', () => {
  const r = parse(SAMPLE);
  assert.equal(r.days, 4);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.classes, {
    yellow: { name: 'Criminal Justice', teacher: 'John Smith', room: '227' },
    red: { name: 'Functions, Stats, Trig', teacher: 'Ana Garcia', room: '132' },
    blue: { name: 'Team Up With Fitness', teacher: 'Sam Lee', room: 'NGYMHS' },
    pink: { name: 'Introduction to Economics', teacher: 'Riya Patel', room: '224' },
    orange: { name: 'Year Book Lab', teacher: 'Kim L Nguyen', room: '117', lunch: 'B' },
    green: { name: 'Academic Essentials 2', teacher: 'Joe E Brown', room: '289', lunch: 'A' },
    purple: { name: 'Technical Communications', teacher: 'Kyle Davis', room: '206' },
    silver: { name: 'Early Release', teacher: 'Pat Wilson', room: '' }
  });
  assert.ok(Object.keys(r.classes).every((k) => bell.BLOCK_KEYS.includes(k)), 'Advisory is not a block');
});

test('import: plain text (no bullets or links) and Windows line endings work too', () => {
  const plain = SAMPLE.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[ \t]*\* /gm, '').replace(/\n/g, '\r\n');
  assert.deepEqual(parse(plain).classes, parse(SAMPLE).classes);
});

test('import: a block with two different classes keeps the first and says so; junk gives nothing', () => {
  const r = parse('Day: A\nPeriod Yellow\nChemistry\nTeacher: Lee, Ann\nDay: B\nPeriod Yellow\nPhysics\n7:30 AM - 8:32 AM\nTeacher: Ng, Bo');
  assert.deepEqual(r.classes, { yellow: { name: 'Chemistry', teacher: 'Ann Lee', room: '' } });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Yellow has two classes \("Chemistry" and "Physics"\)/);
  for (const junk of ['', 'hello world', 'Period Plaid\nArt', null, undefined]) assert.deepEqual(parse(junk).classes, {}, String(junk));
  assert.equal(parse('Period Green\nLunch: D 1:00-1:25\nArt').classes.green.lunch, undefined, 'only A, B or C');
  assert.equal(teacherName('Nguyen, Kim L'), 'Kim L Nguyen');
  assert.equal(teacherName('Ms. Nguyen'), 'Ms. Nguyen');
});

test('classes match by teacher last name, however it is written', () => {
  const same = (t1, t2) => bell.sameClass({ name: 'Algebra II', teacher: t1 }, { name: 'algebra ii', teacher: t2 });
  assert.ok(same('Mr. Smith', 'John Smith'));
  assert.ok(same('Smith, John', 'smith'));
  assert.ok(same('Smith J.', 'Mrs. Smith'));
  assert.ok(same('', 'Smith'), 'no teacher on one side matches');
  assert.ok(!same('Jones', 'Smith'));
  assert.ok(!bell.sameClass({ name: 'Algebra', teacher: 'Smith' }, { name: 'Geometry', teacher: 'Smith' }));
});
