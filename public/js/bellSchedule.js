// Mukwonago High School bell schedule, from the official "MHS Hallway Bell
// Schedule" doc linked from mhs.masd.k12.wi.us. Times are 24-hour 'HH:MM'
// in school time (see SCHOOL_TZ on the server, America/Chicago by default).
// Loaded by the browser (<script>) and by the tests (require).
(function (root) {
  'use strict';

  const SCHEDULES = {
    daily: {
      key: 'daily',
      label: 'Daily',
      periods: [
        { hour: 1, label: 'Hour 1', start: '07:30', end: '08:32' },
        { hour: 2, label: 'Hour 2', start: '08:37', end: '09:39' },
        { hour: 3, label: 'Hour 3', start: '09:49', end: '10:51', note: { text: 'MTV & Announcements', start: '09:44', end: '09:49' } },
        { hour: 4, label: 'Hour 4 (+ Lunch)', start: '10:56', end: '12:31' },
        { hour: 5, label: 'Hour 5', start: '12:36', end: '13:38' },
        { hour: 6, label: 'Hour 6', start: '13:43', end: '14:45' }
      ]
    },
    advisory: {
      key: 'advisory',
      label: 'Advisory Day',
      periods: [
        { hour: 1, label: 'Hour 1', start: '07:30', end: '08:27' },
        { hour: 2, label: 'Hour 2', start: '08:32', end: '09:29' },
        { hour: 3, label: 'Hour 3', start: '09:34', end: '10:31' },
        { hour: 'advisory', label: 'Advisory', start: '10:36', end: '11:06' },
        { hour: 4, label: 'Hour 4 (+ Lunch)', start: '11:11', end: '12:41' },
        { hour: 5, label: 'Hour 5', start: '12:46', end: '13:43' },
        { hour: 6, label: 'Hour 6', start: '13:48', end: '14:45' }
      ]
    },
    early_release: {
      key: 'early_release',
      label: 'Early Release',
      periods: [
        { hour: 1, label: 'Hour 1', start: '07:30', end: '08:13' },
        { hour: 2, label: 'Hour 2', start: '08:18', end: '09:01' },
        { hour: 3, label: 'Hour 3', start: '09:06', end: '09:49' },
        { hour: 4, label: 'Hour 4 (+ Lunch)', start: '09:54', end: '11:09' },
        { hour: 5, label: 'Hour 5', start: '11:14', end: '11:57' },
        { hour: 6, label: 'Hour 6', start: '12:02', end: '12:45' }
      ]
    }
  };

  // Color blocks: every class belongs to one color, and the day letter decides
  // which hour that color meets in (the "Daily Schedule" grid). Each day skips two colors.
  const BLOCKS = [
    { key: 'yellow', label: 'Yellow', color: '#ffe14d', ink: '#1f1f1f' },
    { key: 'red', label: 'Red', color: '#e53935', ink: '#ffffff' },
    { key: 'pink', label: 'Pink', color: '#c2189b', ink: '#ffffff' },
    { key: 'green', label: 'Green', color: '#16a34a', ink: '#ffffff' },
    { key: 'orange', label: 'Orange', color: '#ea6a1a', ink: '#ffffff' },
    { key: 'purple', label: 'Purple', color: '#c7a6ff', ink: '#1f1f1f' },
    { key: 'silver', label: 'Silver', color: '#8a8f98', ink: '#ffffff' },
    { key: 'blue', label: 'Blue', color: '#2f6fbf', ink: '#ffffff' }
  ];
  // ROTATION[letter][hour - 1] = block key
  const ROTATION = {
    A: ['yellow', 'red', 'pink', 'green', 'purple', 'silver'],
    B: ['blue', 'red', 'pink', 'orange', 'green', 'silver'],
    C: ['yellow', 'blue', 'pink', 'orange', 'purple', 'green'],
    D: ['yellow', 'red', 'blue', 'orange', 'purple', 'silver']
  };
  const BLOCK_KEYS = BLOCKS.map((b) => b.key);
  // Advisory isn't a color block: it's saved as classes.advisory and shown on Advisory days.
  const ADVISORY = 'advisory';
  const blockInfo = (key) => BLOCKS.find((b) => b.key === key) || null;
  function blockFor(letter, hour) {
    const row = Object.prototype.hasOwnProperty.call(ROTATION, letter) ? ROTATION[letter] : null;
    return row && Number.isInteger(hour) ? row[hour - 1] || null : null;
  }
  // Which hours a block meets in: [{ letter, hour }]
  function meetings(key) {
    const out = [];
    for (const [letter, row] of Object.entries(ROTATION)) row.forEach((k, i) => { if (k === key) out.push({ letter, hour: i + 1 }); });
    return out;
  }

  // Lunch happens inside Hour 4, so it belongs to whichever class you have in Hour 4
  // (Green on Day A, Orange on B-D). LUNCHES[scheduleKey][lunch] = { start, end }
  const LUNCH_HOUR = 4;
  const LUNCH_BLOCKS = [...new Set(Object.values(ROTATION).map((row) => row[LUNCH_HOUR - 1]))];
  const LUNCH_NAMES = ['A', 'B', 'C'];
  const LUNCHES = {
    daily: { A: { start: '10:56', end: '11:21' }, B: { start: '11:31', end: '11:56' }, C: { start: '12:06', end: '12:31' } },
    advisory: { A: { start: '11:11', end: '11:36' }, B: { start: '11:41', end: '12:06' }, C: { start: '12:16', end: '12:41' } },
    early_release: { A: { start: '09:54', end: '10:19' }, B: { start: '10:19', end: '10:44' }, C: { start: '10:44', end: '11:09' } }
  };
  // Someone's lunch ('A' | 'B' | 'C' | null) on a day letter, from their classes.
  function lunchFor(classes, letter) {
    const key = blockFor(letter, LUNCH_HOUR);
    const c = key && classes && Object.prototype.hasOwnProperty.call(classes, key) ? classes[key] : null;
    return c && LUNCH_NAMES.includes(c.lunch) ? c.lunch : null;
  }
  function lunchTimes(scheduleKey, lunch) {
    const day = LUNCHES[scheduleKey] || LUNCHES.daily;
    return LUNCH_NAMES.includes(lunch) ? day[lunch] : null;
  }
  // Is `minutes` inside that lunch? -> { minutesLeft } or null
  function atLunch(scheduleKey, lunch, minutes) {
    const t = lunchTimes(scheduleKey, lunch);
    if (!t) return null;
    const start = timeToMinutes(t.start), end = timeToMinutes(t.end);
    return minutes >= start && minutes < end ? { minutesLeft: end - minutes } : null;
  }

  // Same class = same name, and the same teacher when both have one. Teachers are compared by last
  // name, so "Mr. Smith", "Smith", "Smith, John" and "John Smith" all match.
  const normClass = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function teacherKey(t) {
    let s = String(t || '').toLowerCase();
    if (s.includes(',')) s = s.split(',')[0]; // "Smith, John"
    const words = s.replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter((w) => w.length > 1 && !['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'coach', 'prof', 'sr', 'jr'].includes(w));
    return words.length ? words[words.length - 1] : '';
  }
  function sameClass(a, b) {
    if (!a || !b || normClass(a.name) !== normClass(b.name)) return false;
    const ta = teacherKey(a.teacher), tb = teacherKey(b.teacher);
    return !ta || !tb || ta === tb;
  }

  function timeToMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  // '13:43' -> '1:43 PM'
  function formatTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }

  // Where are we in the day? `minutes` = minutes since midnight (fractional ok).
  //   { status: 'before-school', next, minutesUntil }
  //   { status: 'in-class', period, minutesLeft, next? }
  //   { status: 'passing', next, minutesUntil }
  //   { status: 'after-school' }
  function getCurrentPeriod(scheduleKey, minutes) {
    const schedule = SCHEDULES[scheduleKey] || SCHEDULES.daily;
    const periods = schedule.periods;
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      const start = timeToMinutes(p.start);
      const end = timeToMinutes(p.end);
      if (minutes >= start && minutes < end) {
        return { status: 'in-class', period: p, minutesLeft: end - minutes, next: periods[i + 1] || null };
      }
    }
    const first = timeToMinutes(periods[0].start);
    if (minutes < first) return { status: 'before-school', next: periods[0], minutesUntil: first - minutes };
    const next = periods.find(p => timeToMinutes(p.start) > minutes);
    if (next) return { status: 'passing', next, minutesUntil: timeToMinutes(next.start) - minutes };
    return { status: 'after-school' };
  }

  // The class someone has in `hour` on day `letter` (hour may be 'advisory').
  function classAt(classes, letter, hour) {
    const key = hour === ADVISORY ? ADVISORY : blockFor(letter, hour);
    return key && classes && Object.prototype.hasOwnProperty.call(classes, key) ? classes[key] : null;
  }

  const api = {
    SCHEDULES, ADVISORY, classAt, timeToMinutes, formatTime, getCurrentPeriod,
    BLOCKS, BLOCK_KEYS, ROTATION, blockInfo, blockFor, meetings,
    LUNCH_HOUR, LUNCH_BLOCKS, LUNCH_NAMES, LUNCHES, lunchFor, lunchTimes, atLunch, sameClass, teacherKey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MHSBell = api;
})(typeof window !== 'undefined' ? window : globalThis);
