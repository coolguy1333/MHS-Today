'use strict';
// Calendar sync: a private, unguessable link (https://…/cal/<token>.ics) that calendar apps
// (iPhone, Google, Outlook) subscribe to. It has every school day (7:00 to the last bell, with the
// day letter), your groups' events, events you made, signed up for or were invited to, your study
// sessions, and no-school days. Calendar apps
// can't sign in, so the token is the key: it can be replaced or turned off on the Account page.
const crypto = require('node:crypto');

module.exports = function icalendar(app) {
  const { route, state, db, config, HttpError, limiter, today, cal, bell, features } = app;

  const feedUrl = (u) => (u.calendarToken ? `${config.publicUrl}/cal/${u.calendarToken}.ics` : null);
  const userByToken = (t) => (/^[0-9a-f]{48}$/.test(t) ? Object.values(state.users).find((u) => u.calendarToken === t) || null : null);

  route('GET', '/api/me/calendar', { auth: 'user' }, ({ user }) => ({ url: feedUrl(user) }));
  // Make a link, or replace the old one (the old link stops working).
  route('POST', '/api/me/calendar', { auth: 'user' }, ({ user }) => {
    user.calendarToken = crypto.randomBytes(24).toString('hex');
    db.save();
    return { url: feedUrl(user) };
  });
  route('DELETE', '/api/me/calendar', { auth: 'user' }, ({ user }) => {
    delete user.calendarToken;
    db.save();
    return { url: null };
  });

  // ---------- iCalendar text ----------
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  // Lines longer than 75 bytes are folded (continued on the next line after a space).
  function fold(line) {
    const out = [];
    let cur = '';
    for (const ch of line) {
      if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
      cur += ch;
    }
    out.push(cur);
    return out.join('\r\n ');
  }
  const ymd = (d) => d.replace(/-/g, '');
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // 'YYYY-MM-DD' + 'HH:MM' in the school's time zone -> UTC milliseconds.
  function zonedToUtc(date, time) {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const wanted = Date.UTC(y, m - 1, d, hh, mm);
    let guess = wanted;
    for (let i = 0; i < 3; i++) { // adjust by the zone's offset at that moment (handles DST)
      const local = cal.schoolNow(config.tz, new Date(guess));
      const [ly, lm, ld] = local.date.split('-').map(Number);
      const seen = Date.UTC(ly, lm - 1, ld, Math.floor(local.minutes / 60), Math.floor(local.minutes % 60));
      guess += wanted - seen;
    }
    return guess;
  }

  // One event per school day, from 7:00 until that day's last bell (2:45 PM, or 12:45 PM on early
  // release days), titled with the day letter: "Day B", "Day C · Early release".
  const DAY_START = '07:00';
  const TYPE_NOTES = { advisory: 'Advisory day', early_release: 'Early release' };
  function schoolDays(t) {
    const out = [];
    const c = state.calendar;
    const last = cal.addDays(t, 180);
    let d = cal.addDays(t, -14);
    if (!cal.dayInfo(c, d).schoolDay) d = cal.nextSchoolDay(c, d);
    for (let i = 0; d && d <= last && i < 200; i++, d = cal.nextSchoolDay(c, d)) {
      const info = cal.dayInfo(c, d);
      const periods = (bell.SCHEDULES[info.scheduleType] || bell.SCHEDULES.daily).periods;
      const end = periods[periods.length - 1].end;
      const title = [info.dayLetter ? `Day ${info.dayLetter}` : 'School day', TYPE_NOTES[info.scheduleType]].filter(Boolean).join(' · ');
      out.push({
        uid: `day-${d}`, date: d, time: DAY_START, minutes: bell.timeToMinutes(end) - bell.timeToMinutes(DAY_START), title,
        description: `School day until ${bell.formatTime(end)}${info.dayLetter ? ` (Day ${info.dayLetter})` : ''}`
      });
    }
    return out;
  }

  function build(user) {
    const now = Date.now();
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MHS Hub//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:MHS Hub', `X-WR-TIMEZONE:${config.tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
    const items = features.flatMap((f) => (f.calendarItems ? f.calendarItems(user) : []));
    const t = today();
    items.push(...schoolDays(t));
    for (const [date, label] of Object.entries(state.calendar.noSchool)) {
      if (date >= cal.addDays(t, -30)) items.push({ uid: `noschool-${date}`, date, title: label ? `No school: ${label}` : 'No school' });
    }
    for (const it of items) {
      lines.push('BEGIN:VEVENT', `UID:${it.uid}@mhs-hub`, `DTSTAMP:${stamp(now)}`);
      if (it.time) {
        const start = zonedToUtc(it.date, it.time);
        lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(start + (it.minutes || 60) * 60e3)}`);
      } else {
        lines.push(`DTSTART;VALUE=DATE:${ymd(it.date)}`, `DTEND;VALUE=DATE:${ymd(cal.addDays(it.date, 1))}`, 'TRANSP:TRANSPARENT');
      }
      lines.push(`SUMMARY:${esc(it.title)}`);
      if (it.description) lines.push(`DESCRIPTION:${esc(it.description)}`);
      if (it.location) lines.push(`LOCATION:${esc(it.location)}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  // GET /cal/<token>.ics (served outside /api: calendar apps send no cookies or custom headers)
  function feed(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const m = /^\/cal\/([0-9a-f]{48})\.ics$/.exec(url.pathname);
    const user = m ? userByToken(m[1]) : null;
    if (!user) throw new HttpError(404, 'Not found');
    if (!limiter.hit(`cal:${user.id}`, 120, 3600e3)) throw new HttpError(429, 'Too many requests');
    const body = build(user);
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline; filename="mhs-hub.ics"'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return {
    feed, build,
    status: () => ({}),
    exportData: () => ({}),
    importData() {},
    maintain() {},
    forgetUser() {}
  };
};
