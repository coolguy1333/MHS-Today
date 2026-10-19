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

  const api = { parse, teacherName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MHSImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
