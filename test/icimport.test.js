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
    silver: { name: 'Early Release', teacher: 'Pat Wilson', room: '' },
    advisory: { name: 'Advisory (Seniors)', teacher: 'John Smith', room: '227' }
  });
});

test('import: Advisory as "Period ADV", "Period Advisory" or a bare "ADV" line', () => {
  const pasted = 'ADV\n[Advisory (Juniors)](https://x.infinitecampus.org/campus/apps/portal/student/section/1)\n7:30 AM - 7:30 AM\n\n* Teacher: Cuellar, Erin H\n* Room: 119';
  assert.deepEqual(parse(pasted).classes, { advisory: { name: 'Advisory (Juniors)', teacher: 'Erin H Cuellar', room: '119' } });
  assert.deepEqual(parse('Period Advisory\nAdvisory (Seniors)\nRoom: 2').classes.advisory, { name: 'Advisory (Seniors)', teacher: '', room: '2' });
  const c = { yellow: { name: 'Math' }, advisory: { name: 'Advisory (Juniors)' } };
  assert.equal(bell.classAt(c, 'A', 'advisory').name, 'Advisory (Juniors)');
  assert.equal(bell.classAt(c, 'A', 1).name, 'Math');
  assert.equal(bell.classAt(c, 'B', 1), null);
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

// A MukReady day copied from Infinite Campus (names changed)
const MUK = `Term Qtr 2
(11/02/2026 - 01/14/2027)
Day: MukReady

* Period Pre-Adv
[Advisory (Juniors)](https://x.infinitecampus.org/campus/apps/portal/student/section/1)
7:30 AM - 8:05 AM
   * Teacher: Smith, John
   * Room: 119
* Period Speaker1
[Track #1](https://x.infinitecampus.org/campus/apps/portal/student/section/2)
8:10 AM - 8:40 AM
   * Teacher: Lee, Sam
   * Room: 19
   * Start: 11/04/2026
   * Complete: 11/04/2026
* Period PostAdvJob
[Advisory (Juniors)](https://x.infinitecampus.org/campus/apps/portal/student/section/1)
9:55 AM - 10:51 AM
* Period Green
[Junior English](https://x.infinitecampus.org/campus/apps/portal/student/section/3)
10:56 AM - 12:31 PM
   * Lunch: A 10:56-11:21 Adv 11:11-11:36
* Period Purple
[AP Physics I](https://x.infinitecampus.org/campus/apps/portal/student/section/4)
12:36 PM - 1:38 PM
* Period Silver
[Personal Finance](https://x.infinitecampus.org/campus/apps/portal/student/section/5)
1:43 PM - 2:45 PM
Day: A
Period Yellow
Math
7:30 AM - 8:32 AM`;

test('import a day: periods and times only, colors as hours, advisory, lunch and the date', () => {
  const { parseDay } = require('../public/js/icimport.js');
  const r = parseDay(MUK);
  assert.equal(r.name, 'MukReady');
  assert.deepEqual(r.periods, [
    { label: 'Pre-Adv', start: '07:30', end: '08:05', hour: 'advisory' },
    { label: 'Speaker 1', start: '08:10', end: '08:40', hour: null },
    { label: 'Post Adv Job', start: '09:55', end: '10:51', hour: 'advisory' },
    { label: 'Hour 4 (+ Lunch)', start: '10:56', end: '12:31', hour: 4 },
    { label: 'Hour 5', start: '12:36', end: '13:38', hour: 5 },
    { label: 'Hour 6', start: '13:43', end: '14:45', hour: 6 }
  ], 'green, purple, silver fit Day A as hours 4-6; only the first day is read');
  assert.deepEqual(r.lunch, { letter: 'A', start: '10:56', end: '11:21' });
  assert.deepEqual(r.dates, ['2026-11-04']);
  assert.ok(!JSON.stringify(r).match(/English|Smith|Track|119/), 'no classes, teachers or rooms');
  assert.deepEqual(parseDay('nothing here').periods, []);
});

test('custom schedules in the bell module: looked up by key, lunches follow Hour 4', () => {
  bell.useCustom({ 'x-late': { label: 'Late start', lunches: {}, periods: [{ label: 'Hour 4', start: '11:56', end: '13:31', hour: 4 }, { label: 'Assembly', start: '13:36', end: '14:00', hour: null }] } });
  assert.equal(bell.scheduleName('x-late'), 'Late start');
  assert.equal(bell.scheduleName('advisory'), 'Advisory');
  assert.deepEqual(bell.lunchTimes('x-late', 'B'), { start: '12:31', end: '12:56' }, 'an hour later, like Hour 4');
  assert.equal(bell.getCurrentPeriod('x-late', 13 * 60 + 40).period.label, 'Assembly');
  bell.useCustom({});
  assert.equal(bell.SCHEDULES['x-late'], undefined);
  assert.equal(bell.getCurrentPeriod('x-late', 8 * 60).period.label, 'Hour 1', 'unknown keys fall back to the regular day');
});

test('Early Release and Late Arrival are out of school, and never make two people classmates', () => {
  for (const name of ['Early Release', 'EARLY RELEASE (PM)', 'Late Arrival', 'Late Start', 'Work Release']) assert.equal(bell.outOfSchool({ name }), true, name);
  for (const name of ['Release the Kraken 101', 'English', '']) assert.equal(bell.outOfSchool({ name }), false, name);
  assert.equal(bell.outOfSchool(null), false);
  assert.equal(bell.sameClass({ name: 'Early Release', teacher: 'Pat Wilson' }, { name: 'Early Release', teacher: 'Pat Wilson' }), false);
  assert.equal(bell.sameClass({ name: 'English' }, { name: 'english' }), true);
});

test('MTV and announcements are the start of Hour 3, not a passing period', () => {
  const p3 = bell.SCHEDULES.daily.periods.find((p) => p.hour === 3);
  assert.deepEqual([p3.start, p3.end, p3.note.start, p3.note.end], ['09:44', '10:51', '09:44', '09:49']);
  assert.equal(bell.getCurrentPeriod('daily', 9 * 60 + 46).status, 'in-class');
  assert.equal(bell.getCurrentPeriod('daily', 9 * 60 + 46).period.hour, 3);
});
