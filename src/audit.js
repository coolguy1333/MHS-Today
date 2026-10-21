'use strict';
// The audit log: who did what, and when, so the owners can let the school or district look into
// something if they need to (MHS Today is independent, not run by the school). Kept forever (never pruned or
// rotated) in $DATA_DIR/audit.log, one JSON object per line, in the order things happened:
//   { at, action, actor: { id, name, email } | null, target, detail, ip }
// It lives next to db.json, so WebManager's backups of /data include it; it is not part of the
// in-app backup download. Only owners (ADMIN_EMAILS) can read or download it.
const fs = require('node:fs');
const path = require('node:path');

const CHUNK = 64 * 1024;

function openAudit(dataDir, log = () => {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'audit.log');
  let fd = fs.openSync(file, 'a', 0o600);

  function record(action, { actor = null, target = null, detail = null, ip = null } = {}) {
    const entry = { at: new Date(Date.now()).toISOString(), action, actor, target, detail, ip };
    try {
      if (fd === null) fd = fs.openSync(file, 'a', 0o600); // something happened after close(): still keep it
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
    } catch (e) { log(`Audit log write failed: ${e.message}`); }
  }

  // Newest first, starting before byte offset `before` (the `next` of the previous page). Reads the
  // file backwards a chunk at a time, so memory stays small however big it grows. `keep(entry)` picks
  // entries; `done(entry)` stops the search (entries are in time order, so a "from" date can stop it).
  function page({ before = null, limit = 100, q = '', keep = null, done = null } = {}) {
    const needle = String(q || '').toLowerCase();
    const rfd = fs.openSync(file, 'r');
    try {
      let end = fs.fstatSync(rfd).size;
      if (Number.isSafeInteger(before) && before >= 0 && before < end) end = before;
      const entries = [];
      let tail = Buffer.alloc(0); // the start of a line whose beginning is in an earlier chunk
      let pos = end;
      let stopped = false;
      while (pos > 0 && entries.length < limit && !stopped) {
        const start = Math.max(0, pos - CHUNK);
        const buf = Buffer.alloc(pos - start);
        fs.readSync(rfd, buf, 0, buf.length, start);
        let data = Buffer.concat([buf, tail]);
        let cut = data.length;
        // walk the complete lines in this chunk from the end
        for (let i = data.length - 1; i >= -1 && entries.length < limit; i--) {
          if (i >= 0 && data[i] !== 10) continue;
          if (i < 0 && start > 0) break; // the first line may continue in the previous chunk
          const lineStart = i + 1;
          const line = data.subarray(lineStart, cut).toString('utf8').trim();
          cut = i;
          if (!line) continue;
          if (needle && !line.toLowerCase().includes(needle)) continue;
          let e;
          try { e = JSON.parse(line); } catch { continue; } // a damaged line is skipped
          if (done && done(e)) { pos = 0; tail = Buffer.alloc(0); stopped = true; break; }
          if (!keep || keep(e)) entries.push({ ...e, pos: start + lineStart });
        }
        if (stopped) break;
        tail = data.subarray(0, Math.max(cut, 0));
        if (entries.length >= limit) { pos = start + Math.max(cut, 0); break; }
        pos = start;
      }
      const next = entries.length >= limit && entries[entries.length - 1].pos > 0 ? entries[entries.length - 1].pos : null;
      return { entries, next };
    } finally {
      fs.closeSync(rfd);
    }
  }

  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s;
  };
  // The whole log, oldest first, as JSON lines or as a spreadsheet (CSV), streamed. Resolves when sent.
  function download(res, format) {
    const done = new Promise((resolve) => res.on('close', resolve));
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    if (format !== 'csv') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="mhs-today-audit-${day}.jsonl"`, 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return done;
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="mhs-today-audit-${day}.csv"`, 'Cache-Control': 'no-store' });
    res.write('\ufefftime,action,by,by email,target,detail,ip\r\n');
    let rest = '';
    const rows = (lines) => {
      const out = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        out.push([e.at, e.action, e.actor && e.actor.name, e.actor && e.actor.email, e.target, e.detail, e.ip].map(csvCell).join(',') + '\r\n');
      }
      return out.join('');
    };
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      const text = rows(lines);
      if (text && !res.write(text)) { stream.pause(); res.once('drain', () => stream.resume()); }
    });
    stream.on('end', () => res.end(rows([rest])));
    stream.on('error', () => res.destroy());
    return done;
  }

  function close() {
    if (fd !== null) { fs.closeSync(fd); fd = null; }
  }
  return { record, page, download, file, close };
}

module.exports = { openAudit };
