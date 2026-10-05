'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../public/js/calendar.js');
const bell = require('../public/js/bellSchedule.js');

// Mon 2026-09-28 is Day B; Thanksgiving break removes Thu/Fri Nov 26-27 2026.
const base = { ...cal.emptyCalendar(), anchorDate: '2026-09-28', anchorLetter: 'B' };
const letter = (c, d) => cal.dayInfo(c, d).dayLetter;

test('parseDate rejects impossible dates', () => {
  assert.equal(cal.parseDate('2026-02-31'), null);
  assert.equal(cal.parseDate('2026-13-01'), null);
  assert.equal(cal.parseDate('0050-01-01'), null);
  assert.equal(cal.parseDate('2026-2-3'), null);
  assert.equal(cal.parseDate(20260101), null);
  assert.notEqual(cal.parseDate('2024-02-29'), null);
  assert.equal(cal.parseDate('2026-02-29'), null);
});

test('letters advance one per school day and skip weekends', () => {
  assert.equal(letter(base, '2026-09-28'), 'B'); // Mon
  assert.equal(letter(base, '2026-09-29'), 'C');
  assert.equal(letter(base, '2026-09-30'), 'D');
  assert.equal(letter(base, '2026-10-01'), 'A');
  assert.equal(letter(base, '2026-10-02'), 'B'); // Fri
  assert.equal(letter(base, '2026-10-05'), 'C'); // next Mon follows Fri
});

test('letters count backwards before the anchor', () => {
  assert.equal(letter(base, '2026-09-25'), 'A'); // Fri before
  assert.equal(letter(base, '2026-09-24'), 'D');
  assert.equal(letter(base, '2026-09-23'), 'C');
  assert.equal(letter(base, '2026-09-22'), 'B');
  assert.equal(letter(base, '2026-09-21'), 'A'); // a full week back: 5 school days, B-5 = A
});

test('backwards math agrees with forwards math', () => {
  // Re-anchor on a later date using the letter computed going forward; earlier dates must be unchanged.
  const fwd = letter(base, '2026-11-02');
  const moved = { ...base, anchorDate: '2026-11-02', anchorLetter: fwd };
  for (let d = '2026-08-24'; d < '2026-12-20'; d = cal.addDays(d, 1)) {
    assert.equal(letter(moved, d), letter(base, d), d);
  }
});

test('no-school days have no letter and are skipped by the rotation', () => {
  const c = { ...base, noSchool: { '2026-09-30': 'Teacher workday' } };
  const info = cal.dayInfo(c, '2026-09-30');
  assert.equal(info.schoolDay, false);
  assert.equal(info.reason, 'no-school');
  assert.equal(info.label, 'Teacher workday');
  assert.equal(info.dayLetter, null);
  assert.equal(letter(c, '2026-10-01'), 'D'); // Wed skipped, so Thu is D not A
});

test('weekends are not school days', () => {
  const info = cal.dayInfo(base, '2026-10-03');
  assert.equal(info.schoolDay, false);
  assert.equal(info.reason, 'weekend');
});

test('anchor on a non-school day means the next school day gets the letter', () => {
  const c = { ...base, anchorDate: '2026-10-03', anchorLetter: 'C' }; // Saturday
  assert.equal(letter(c, '2026-10-05'), 'C');
  assert.equal(letter(c, '2026-10-02'), 'B');
});

test('schedule types: date override beats weekday pattern beats daily', () => {
  const c = { ...base, weekdayTypes: { 3: 'early_release' }, types: { '2026-10-07': 'advisory', '2026-10-14': 'daily' } };
  assert.equal(cal.dayInfo(c, '2026-09-30').scheduleType, 'early_release'); // a Wednesday
  assert.equal(cal.dayInfo(c, '2026-10-07').scheduleType, 'advisory');
  assert.equal(cal.dayInfo(c, '2026-10-14').scheduleType, 'daily');
  assert.equal(cal.dayInfo(c, '2026-09-29').scheduleType, 'daily');
});

test('no anchor -> no letter, never throws', () => {
  assert.equal(letter(cal.emptyCalendar(), '2026-09-30'), null);
  assert.equal(letter({ ...base, anchorLetter: 'Z' }, '2026-09-30'), null);
  assert.equal(letter(base, '2035-01-01'), null); // absurdly far away
  assert.throws(() => cal.dayInfo(base, 'nope'));
});

test('nextSchoolDay skips weekends and holidays in both directions', () => {
  const c = { ...base, noSchool: { '2026-10-05': 'x' } };
  assert.equal(cal.nextSchoolDay(c, '2026-10-02'), '2026-10-06');
  assert.equal(cal.nextSchoolDay(c, '2026-10-06', -1), '2026-10-02');
});

test('schoolNow uses the school time zone, not the machine zone', () => {
  const t = new Date('2026-09-30T03:30:00Z'); // 10:30 PM Sep 29 in Chicago (CDT)
  const n = cal.schoolNow('America/Chicago', t);
  assert.equal(n.date, '2026-09-29');
  assert.equal(n.minutes, 22 * 60 + 30);
  const mid = cal.schoolNow('America/Chicago', new Date('2026-09-30T05:00:00Z')); // midnight, must be 0 not 24
  assert.equal(mid.date, '2026-09-30');
  assert.equal(mid.minutes, 0);
});

test('cleanCalendar drops junk and keeps valid data', () => {
  const c = cal.cleanCalendar({
    anchorDate: '2026-09-28', anchorLetter: 'C',
    noSchool: { '2026-11-26': 'Thanks\u0000giving\n', 'bad': 'x', '2026-02-31': 'y', __proto__: 'z' },
    types: { '2026-10-07': 'advisory', '2026-10-08': 'lunch' },
    weekdayTypes: { 3: 'early_release', 1: 'daily', 9: 'advisory', 2: 'nonsense' }
  });
  assert.equal(c.anchorLetter, 'C');
  assert.deepEqual(c.noSchool, { '2026-11-26': 'Thanks giving' });
  assert.deepEqual(c.types, { '2026-10-07': 'advisory' });
  assert.deepEqual(c.weekdayTypes, { 3: 'early_release' });
  assert.deepEqual(cal.cleanCalendar(null), cal.emptyCalendar());
  assert.equal(cal.cleanCalendar({ anchorDate: '1999-01-01' }).anchorDate, null);
  const pruned = cal.cleanCalendar({ noSchool: { '2024-01-01': 'old', '2026-09-01': 'new' } }, '2026-09-30');
  assert.deepEqual(Object.keys(pruned.noSchool), ['2026-09-01']);
});

test('bell: period status and countdowns', () => {
  const at = (hhmm) => bell.timeToMinutes(hhmm);
  let r = bell.getCurrentPeriod('daily', at('07:00'));
  assert.equal(r.status, 'before-school'); assert.equal(r.minutesUntil, 30); assert.equal(r.next.hour, 1);
  r = bell.getCurrentPeriod('daily', at('07:30'));
  assert.equal(r.status, 'in-class'); assert.equal(r.period.hour, 1); assert.equal(r.minutesLeft, 62); assert.equal(r.next.hour, 2);
  r = bell.getCurrentPeriod('daily', at('08:32')); // exactly at the end -> passing
  assert.equal(r.status, 'passing'); assert.equal(r.next.hour, 2); assert.equal(r.minutesUntil, 5);
  r = bell.getCurrentPeriod('daily', at('14:44'));
  assert.equal(r.status, 'in-class'); assert.equal(r.next, null);
  assert.equal(bell.getCurrentPeriod('daily', at('14:45')).status, 'after-school');
  assert.equal(bell.getCurrentPeriod('advisory', at('10:40')).period.hour, 'advisory');
  assert.equal(bell.getCurrentPeriod('nonsense', at('08:00')).status, 'in-class'); // falls back to daily
});

test('bell: 12-hour formatting', () => {
  assert.equal(bell.formatTime('00:05'), '12:05 AM');
  assert.equal(bell.formatTime('07:30'), '7:30 AM');
  assert.equal(bell.formatTime('12:00'), '12:00 PM');
  assert.equal(bell.formatTime('13:43'), '1:43 PM');
});

test('bell: every schedule is ordered and non-overlapping', () => {
  for (const s of Object.values(bell.SCHEDULES)) {
    let prevEnd = -1;
    for (const p of s.periods) {
      const a = bell.timeToMinutes(p.start), b = bell.timeToMinutes(p.end);
      assert.ok(a > prevEnd && b > a, `${s.key} ${p.label}`);
      prevEnd = b;
    }
  }
});
