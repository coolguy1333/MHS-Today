// Mukwonago High School bell schedule, sourced from the official
// "MHS Hallway Bell Schedule" doc linked from mhs.masd.k12.wi.us.

const SCHEDULES = {
  daily: {
    key: 'daily',
    label: 'Daily (A/B/C/D)',
    periods: [
      { hour: 1, label: 'Hour 1', start: '07:30', end: '08:32' },
      { hour: 2, label: 'Hour 2', start: '08:37', end: '09:39' },
      { hour: 3, label: 'Hour 3', start: '09:49', end: '10:51', note: 'MTV & Announcements 9:44–9:49' },
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

// Given a schedule key and a Date, return current status + period.
function getCurrentPeriod(scheduleKey, now) {
  now = now || new Date();
  const schedule = SCHEDULES[scheduleKey] || SCHEDULES.daily;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const p of schedule.periods) {
    const start = timeToMinutes(p.start);
    const end = timeToMinutes(p.end);
    if (nowMin >= start && nowMin < end) {
      return { status: 'in-class', period: p };
    }
  }
  if (nowMin < timeToMinutes(schedule.periods[0].start)) {
    return { status: 'before-school', next: schedule.periods[0] };
  }
  const next = schedule.periods.find(p => timeToMinutes(p.start) > nowMin);
  if (next) return { status: 'passing', next };
  return { status: 'after-school' };
}
