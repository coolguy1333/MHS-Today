// School calendar logic. Loaded by the browser (<script>) and by the server
// (require) so both always agree on the day letter and schedule type.
//
// A calendar is plain data:
//   anchorDate    'YYYY-MM-DD' | null   a date whose letter is known...
//   anchorLetter  'A'..'D'              ...the first school day on/after it is this letter
//   noSchool      { 'YYYY-MM-DD': 'label' }   holidays/breaks (weekends are implicit)
//   types         { 'YYYY-MM-DD': 'advisory' | 'early_release' | 'daily' }   one-off overrides
//   weekdayTypes  { '1'..'5': 'advisory' | 'early_release' }   repeating pattern (1 = Monday)
//   customTypes   { 'x-…': { label, periods: [{ label, start, end, hour, info }], lunches } }
//                 schedules admins make (MukReady…); `types` and `weekdayTypes` can use their keys.
//                 hour: 1-6 (the color block for the day letter), 'advisory', or null (not a class).
// The letter advances by one on every school day (weekday that is not in noSchool).
(function (root) {
  'use strict';

  const DAY_MS = 86400000;
  const LETTERS = ['A', 'B', 'C', 'D'];
  const TYPES = ['daily', 'advisory', 'early_release'];
  const MAX_SPAN_DAYS = 1500;
  const CUSTOM_KEY = /^x-[a-z0-9-]{1,24}$/;
  const MAX_CUSTOM = 12, MAX_PERIODS = 16;
  const HOURS = [1, 2, 3, 4, 5, 6, 'advisory'];
  const LUNCH_NAMES = ['A', 'B', 'C']; // don't loop forever for absurd dates
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  // 'YYYY-MM-DD' -> UTC midnight in ms, or null if it isn't a real date.
  function parseDate(s) {
    if (typeof s !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const ms = Date.UTC(y, mo - 1, d);
    const dt = new Date(ms);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return ms;
  }
  function formatDate(ms) {
    const d = new Date(ms);
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  function addDays(dateStr, n) {
    const ms = parseDate(dateStr);
    if (ms === null) throw new Error('Invalid date');
    return formatDate(ms + n * DAY_MS);
  }

  function emptyCalendar() {
    return { anchorDate: null, anchorLetter: 'A', noSchool: {}, types: {}, weekdayTypes: {}, customTypes: {} };
  }

  function isSchoolMs(cal, ms) {
    const dow = new Date(ms).getUTCDay();
    if (dow === 0 || dow === 6) return false;
    return !hasOwn(cal.noSchool, formatDate(ms));
  }

  // Day letter for a school day (given as UTC ms), or null if unknown.
  function letterFor(cal, ms) {
    const anchor = parseDate(cal.anchorDate);
    const base = LETTERS.indexOf(cal.anchorLetter);
    if (anchor === null || base < 0) return null;
    if (Math.abs(ms - anchor) / DAY_MS > MAX_SPAN_DAYS) return null;
    let n = 0;
    if (ms >= anchor) {
      for (let t = anchor; t < ms; t += DAY_MS) if (isSchoolMs(cal, t)) n++;
    } else {
      for (let t = ms; t < anchor; t += DAY_MS) if (isSchoolMs(cal, t)) n--;
    }
    return LETTERS[(((base + n) % 4) + 4) % 4];
  }

  // Everything the UI needs to know about one date.
  function dayInfo(cal, dateStr) {
    const ms = parseDate(dateStr);
    if (ms === null) throw new Error('Invalid date');
    const dow = new Date(ms).getUTCDay();
    const info = { date: dateStr, weekday: dow, schoolDay: true, reason: null, label: '', dayLetter: null, scheduleType: 'daily' };
    if (dow === 0 || dow === 6) {
      info.schoolDay = false; info.reason = 'weekend';
      return info;
    }
    if (hasOwn(cal.noSchool, dateStr)) {
      info.schoolDay = false; info.reason = 'no-school'; info.label = cal.noSchool[dateStr] || '';
      return info;
    }
    if (hasOwn(cal.types, dateStr)) info.scheduleType = cal.types[dateStr];
    else if (hasOwn(cal.weekdayTypes, String(dow))) info.scheduleType = cal.weekdayTypes[String(dow)];
    info.dayLetter = letterFor(cal, ms);
    return info;
  }

  // Nearest school day strictly after/before dateStr (within ~a year), or null.
  function nextSchoolDay(cal, dateStr, step = 1) {
    let ms = parseDate(dateStr);
    if (ms === null) return null;
    for (let i = 0; i < 400; i++) {
      ms += step * DAY_MS;
      if (isSchoolMs(cal, ms)) return formatDate(ms);
    }
    return null;
  }

  // Current date + minutes-since-midnight (fractional) in a time zone.
  const formatters = new Map();
  function schoolNow(tz, now) {
    const when = now instanceof Date ? now : new Date(Date.now()); // via Date.now so tests can pin the clock
    let f = formatters.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      formatters.set(tz, f);
    }
    const p = {};
    for (const part of f.formatToParts(when)) p[part.type] = part.value;
    return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute + +p.second / 60 };
  }

  const cleanLabel = (v) =>
    String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

  const okTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  // A custom day schedule, or null if it can't be used. Periods are sorted, and ones that overlap the
  // one before are dropped.
  function cleanCustomType(src) {
    if (!src || typeof src !== 'object') return null;
    const label = cleanLabel(src.label).slice(0, 40);
    const periods = [];
    const list = Array.isArray(src.periods) ? src.periods.slice(0, MAX_PERIODS) : [];
    for (const p of list.filter((x) => x && okTime(x.start) && okTime(x.end) && x.start < x.end).sort((a, b) => (a.start < b.start ? -1 : 1))) {
      const name = cleanLabel(p.label).slice(0, 30);
      if (!name || (periods.length && p.start < periods[periods.length - 1].end)) continue;
      const out = { label: name, start: p.start, end: p.end, hour: HOURS.includes(p.hour) ? p.hour : null };
      const info = cleanLabel(p.info);
      if (info) out.info = info; // shown where the class would be ("Your track's room is in Infinite Campus")
      periods.push(out);
    }
    if (!label || !periods.length) return null;
    const lunches = {};
    const ls = src.lunches && typeof src.lunches === 'object' ? src.lunches : {};
    for (const l of LUNCH_NAMES) {
      const t = ls[l];
      if (t && okTime(t.start) && okTime(t.end) && t.start < t.end) lunches[l] = { start: t.start, end: t.end };
    }
    return { label, periods, lunches };
  }

  // Validate + normalise untrusted calendar data (admin input, backup files).
  // Drops anything invalid rather than failing; `today` (optional) prunes entries over a year old.
  function cleanCalendar(input, today) {
    const src = input && typeof input === 'object' ? input : {};
    const out = emptyCalendar();
    const minDate = today && parseDate(today) !== null ? addDays(today, -365) : '0000-00-00';
    const okDate = (d) => parseDate(d) !== null && d >= '2000-01-01' && d <= '2100-12-31';

    if (okDate(src.anchorDate)) out.anchorDate = src.anchorDate;
    if (LETTERS.includes(src.anchorLetter)) out.anchorLetter = src.anchorLetter;

    const ct = src.customTypes && typeof src.customTypes === 'object' ? src.customTypes : {};
    for (const k of Object.keys(ct)) {
      if (Object.keys(out.customTypes).length >= MAX_CUSTOM) break;
      const t = CUSTOM_KEY.test(k) ? cleanCustomType(ct[k]) : null;
      if (t) out.customTypes[k] = t;
    }
    const okType = (t) => TYPES.includes(t) || (typeof t === 'string' && hasOwn(out.customTypes, t));

    const ns = src.noSchool && typeof src.noSchool === 'object' ? src.noSchool : {};
    for (const d of Object.keys(ns).sort()) {
      if (Object.keys(out.noSchool).length >= 400) break;
      if (okDate(d) && d >= minDate) out.noSchool[d] = cleanLabel(ns[d]);
    }
    const ty = src.types && typeof src.types === 'object' ? src.types : {};
    for (const d of Object.keys(ty).sort()) {
      if (Object.keys(out.types).length >= 400) break;
      if (okDate(d) && d >= minDate && okType(ty[d])) out.types[d] = ty[d];
    }
    const wt = src.weekdayTypes && typeof src.weekdayTypes === 'object' ? src.weekdayTypes : {};
    for (const k of ['1', '2', '3', '4', '5']) {
      if (hasOwn(wt, k) && okType(wt[k]) && wt[k] !== 'daily') out.weekdayTypes[k] = wt[k];
    }
    return out;
  }

  const api = {
    LETTERS, TYPES, CUSTOM_KEY, parseDate, formatDate, addDays, emptyCalendar, dayInfo, nextSchoolDay, schoolNow, cleanCalendar
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MHSCalendar = api;
})(typeof window !== 'undefined' ? window : globalThis);
