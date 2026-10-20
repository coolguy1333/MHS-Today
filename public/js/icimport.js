// Reads a schedule copied from Infinite Campus (Schedule page, all days) and turns it into color
// blocks. Runs in the browser only: the pasted text never leaves the page. Loaded by the Schedule
// page (<script>) and by the tests (require).
//
// What a copied schedule looks like (bullets and [links](…) may or may not be there):
//   Day: A
//   Period Yellow
//   Criminal Justice                 <- the class
//   7:30 AM - 8:32 AM
//   Teacher: Smith, John
//   Room: 227
//   Lunch: A 10:56-11:21 Adv 11:11-11:36
// Advisory comes as "Period ADV" or "Period Advisory" and is kept as `advisory`.
(function (root) {
  'use strict';
  const BLOCKS = ['yellow', 'red', 'pink', 'green', 'orange', 'purple', 'silver', 'blue', 'advisory'];
  const LUNCHES = ['A', 'B', 'C'];

  // 'Smith, John A' -> 'John A Smith'
  function teacherName(s) {
    const t = s.replace(/\s+/g, ' ').trim();
    const i = t.indexOf(',');
    return i > 0 ? `${t.slice(i + 1).trim()} ${t.slice(0, i).trim()}`.trim() : t;
  }
  // One line without list bullets, and [text](link) as just text.
  const tidy = (line) => line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[\s*\-•·◦▪]+/, '').replace(/\s+/g, ' ').trim();
  const isTime = (l) => /^\d{1,2}:\d{2}\s*[AP]\.?M\.?\s*[-–]\s*\d{1,2}:\d{2}/i.test(l);
  const field = (l) => /^([A-Za-z ]{2,20}):\s*(.*)$/.exec(l);

  // -> { classes: { yellow: { name, teacher, room, lunch? } }, days: number, warnings: [text] }
  function parse(text) {
    const classes = {};
    const warnings = [];
    let days = 0;
    let cur = null; // the block (or advisory) being read, or null for anything else
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = tidy(raw);
      if (!line) continue;
      if (/^Day\s*:/i.test(line)) { days++; cur = null; continue; }
      const period = /^Period\s+(.+)$/i.exec(line) || (/^ADV$/i.test(line) ? [line, line] : null);
      if (period) {
        let key = period[1].toLowerCase().replace(/[^a-z]/g, '');
        if (key === 'adv') key = 'advisory';
        cur = BLOCKS.includes(key) ? { block: key, name: '', teacher: '', room: '', lunch: '' } : null;
        if (cur) {
          if (!classes[key]) classes[key] = cur;
          else cur = { ...cur, existing: classes[key] }; // seen on another day: only fill in what's missing
        }
        continue;
      }
      if (!cur || isTime(line)) continue;
      const target = cur.existing || cur;
      const f = field(line);
      if (f) {
        const k = f[1].trim().toLowerCase();
        const v = f[2].trim();
        if (k === 'teacher' && !target.teacher) target.teacher = teacherName(v).slice(0, 60);
        else if (k === 'room' && !target.room) target.room = v.slice(0, 20);
        else if (k === 'lunch') {
          const l = /^([A-Z])\b/i.exec(v);
          if (l && LUNCHES.includes(l[1].toUpperCase()) && !target.lunch) target.lunch = l[1].toUpperCase();
        }
        continue;
      }
      // the first plain line after "Period …" is the class name
      if (cur.existing) {
        if (!cur.checked) {
          cur.checked = true;
          if (cur.existing.name && cur.existing.name.toLowerCase() !== line.toLowerCase()) {
            if (cur.block !== 'advisory') warnings.push(`${cur.block[0].toUpperCase()}${cur.block.slice(1)} has two classes ("${cur.existing.name}" and "${line}"). Kept the first one.`);
          }
        }
      } else if (!cur.name) cur.name = line.slice(0, 60);
    }
    const out = {};
    for (const [k, c] of Object.entries(classes)) {
      if (!c.name) continue;
      out[k] = { name: c.name, teacher: c.teacher, room: c.room };
      if (c.lunch) out[k].lunch = c.lunch;
    }
    return { classes: out, days, warnings };
  }

  // ---- one day's bell schedule, for admins making a custom day (MukReady…)
  const bell = root.MHSBell || (typeof require === 'function' ? require('./bellSchedule.js') : null);
  const COLORS = ['yellow', 'red', 'pink', 'green', 'orange', 'purple', 'silver', 'blue'];
  const pad2 = (n) => String(n).padStart(2, '0');
  // '7:30 AM' -> '07:30'; a bare '1:05' (lunch lines have no AM/PM) is read as a school-day time
  function to24(t) {
    const m = /^(\d{1,2}):(\d{2})\s*([AP])?\.?M?\.?$/i.exec(t.trim());
    if (!m) return null;
    let hr = +m[1] % 12;
    if (m[3] ? m[3].toUpperCase() === 'P' : hr < 6) hr += 12;
    return +m[2] < 60 ? `${pad2(hr)}:${m[2]}` : null;
  }
  // 'Speaker1' -> 'Speaker 1', 'PostAdvJob' -> 'Post Adv Job'
  const spaced = (s) => s.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  // Which hour each color meets in: the day letter whose order fits them all (the `letter` given
  // first), else the regular hour that starts closest.
  function colorHours(found, letter) {
    const colors = found.map((p) => p.color);
    const fits = (l) => { const row = bell.ROTATION[l]; let last = 0; return colors.every((c) => { const i = row.indexOf(c) + 1; const ok = i > last; last = i; return ok; }); };
    const l = [letter, ...Object.keys(bell.ROTATION)].find((x) => x && bell.ROTATION[x] && fits(x));
    if (l) return colors.map((c) => bell.ROTATION[l].indexOf(c) + 1);
    const daily = bell.SCHEDULES.daily.periods;
    return found.map((p) => daily.reduce((best, d) => (Math.abs(bell.timeToMinutes(d.start) - bell.timeToMinutes(p.start)) < Math.abs(bell.timeToMinutes(best.start) - bell.timeToMinutes(p.start)) ? d : best)).hour);
  }
  // The first day in a schedule copied from Infinite Campus, as periods for a custom day. Class
  // names, teachers and rooms are left out: a custom day is for everyone.
  // -> { name, periods: [{ label, start, end, hour }], lunch: { letter, start, end } | null, dates: ['YYYY-MM-DD'] }
  function parseDay(text, letter) {
    let name = '', cur = null, lunch = null;
    const found = [], dates = new Set();
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = tidy(raw);
      if (!line) continue;
      const day = /^Day\s*:\s*(.*)$/i.exec(line);
      if (day) { if (found.length) break; name = day[1].slice(0, 40); continue; }
      const period = /^Period\s+(.+)$/i.exec(line);
      if (period) { cur = { raw: period[1].trim(), cls: '', start: '', end: '' }; found.push(cur); continue; }
      if (!cur) continue;
      const time = /^(\d{1,2}:\d{2}\s*[AP]\.?M\.?)\s*[-–]\s*(\d{1,2}:\d{2}\s*[AP]\.?M\.?)/i.exec(line);
      if (time) { if (!cur.start) { cur.start = to24(time[1]) || ''; cur.end = to24(time[2]) || ''; } continue; }
      const f = field(line);
      if (f) {
        const k = f[1].trim().toLowerCase();
        const l = k === 'lunch' && /^([ABC])\s+(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/i.exec(f[2]);
        if (l && !lunch) lunch = { letter: l[1].toUpperCase(), start: to24(l[2]), end: to24(l[3]) };
        const d = (k === 'start' || k === 'complete') && /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(f[2].trim());
        if (d) dates.add(`${d[3]}-${pad2(d[1])}-${pad2(d[2])}`);
        continue;
      }
      if (!cur.cls) cur.cls = line;
    }
    const periods = found.filter((p) => p.start && p.end && p.start < p.end).map((p) => {
      const key = p.raw.toLowerCase().replace(/[^a-z]/g, '');
      if (COLORS.includes(key)) return { ...p, color: key };
      return { ...p, hour: /adv/i.test(p.raw) || /^advisory\b/i.test(p.cls) ? 'advisory' : null };
    });
    const colored = periods.filter((p) => p.color);
    if (colored.length) colorHours(colored, letter).forEach((hr, i) => { colored[i].hour = hr; });
    return {
      name,
      periods: periods.map((p) => ({
        label: p.color ? `Hour ${p.hour}${p.hour === bell.LUNCH_HOUR ? ' (+ Lunch)' : ''}` : spaced(p.raw).slice(0, 30),
        start: p.start, end: p.end, hour: p.hour
      })),
      lunch: lunch && lunch.start && lunch.end ? lunch : null,
      dates: [...dates].sort()
    };
  }

  const api = { parse, parseDay, teacherName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MHSImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
