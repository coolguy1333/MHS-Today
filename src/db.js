'use strict';
// One JSON file, $DATA_DIR/db.json, written atomically (temp file + rename) so a
// crash or a backup taken mid-write never sees a half-written file. Daily
// snapshots go to $DATA_DIR/backups/ (WebManager's /data backups include them).
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 2;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function emptyState() {
  return {
    version: VERSION,
    users: {},     // id -> { id, sub, email, name, created, lastLogin, classes, friends: [ids], friendCode, shareSchedule }
    sessions: {},  // sha256(token) -> { userId, expires }
    events: [],    // { id, title, date, time, description, by (user id), created }
    calendar: { anchorDate: null, anchorLetter: 'A', noSchool: {}, types: {}, weekdayTypes: {} }
  };
}

function openDb(dataDir, log = () => {}) {
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');

  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }

  const state = emptyState();
  if (raw !== null) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      // Refuse to start (and later overwrite) a damaged file.
      throw new Error(`${file} is not valid JSON (${e.message}). Copy a snapshot from ${backupDir} over it, or delete it to start empty.`);
    }
    if (!isObj(parsed)) throw new Error(`${file} has an unexpected format.`);
    if (parsed.version === VERSION) {
      for (const k of ['users', 'sessions', 'calendar']) if (isObj(parsed[k])) state[k] = parsed[k];
      if (Array.isArray(parsed.events)) state.events = parsed.events;
    } else if (parsed.version > VERSION) {
      throw new Error(`${file} was written by a newer version of this app (format ${parsed.version}).`);
    } else {
      // The first release kept passwords in db.json; it can't be migrated to Google sign-in.
      const old = path.join(backupDir, `db.old-format-${Date.now()}.json`);
      fs.writeFileSync(old, raw, { mode: 0o600 });
      log(`Old data format found. Archived to ${old}; starting with an empty database.`);
    }
  }

  let timer = null;
  let dirty = false;

  function writeAtomic(target, text) {
    const tmp = target + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return true;
    try {
      writeAtomic(file, JSON.stringify(state));
      dirty = false;
      return true;
    } catch (e) {
      log(`Could not save data: ${e.message} (will retry)`);
      timer = setTimeout(flush, 5000);
      timer.unref();
      return false;
    }
  }
  function save() {
    dirty = true;
    if (!timer) { timer = setTimeout(flush, 200); timer.unref(); }
  }

  // Snapshots never contain login sessions.
  const snapshotText = () => JSON.stringify({ ...state, sessions: {} });
  function prune(prefix, keep) {
    const names = fs.readdirSync(backupDir).filter((n) => n.startsWith(prefix + '-') && n.endsWith('.json')).sort();
    for (const n of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(backupDir, n), { force: true });
  }
  // prefix 'db' keeps 7 (one per day); 'before-restore' keeps the last 3.
  function snapshot(prefix = 'db') {
    const now = new Date().toISOString();
    const stamp = prefix === 'db' ? now.slice(0, 10) : now.replace(/[:.]/g, '-');
    const name = `${prefix}-${stamp}.json`;
    writeAtomic(path.join(backupDir, name), snapshotText());
    prune(prefix, prefix === 'db' ? 7 : 3);
    return name;
  }
  function dailySnapshot() {
    const name = `db-${new Date().toISOString().slice(0, 10)}.json`;
    if (!fs.existsSync(path.join(backupDir, name))) return snapshot('db');
    return null;
  }
  function lastSnapshot() {
    const names = fs.readdirSync(backupDir).filter((n) => n.startsWith('db-') && n.endsWith('.json')).sort();
    return names.length ? names[names.length - 1] : null;
  }
  function close() { flush(); }

  return { state, save, flush, snapshot, dailySnapshot, lastSnapshot, close, file, backupDir };
}

module.exports = { openDb, emptyState, VERSION };
