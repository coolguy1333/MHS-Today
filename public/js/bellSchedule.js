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

  const api = { SCHEDULES, timeToMinutes, formatTime, getCurrentPeriod };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MHSBell = api;
})(typeof window !== 'undefined' ? window : globalThis);
