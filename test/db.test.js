'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cal = require('../public/js/calendar.js');
const { openDb } = require('../src/db');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { startApp, closeAll, freePort } = require('./helpers');

test.afterEach(closeAll);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mhs-db-'));
const today = () => cal.schoolNow('America/Chicago').date;
const makeApp = (dir, env = {}) => createApp(loadConfig({ DATA_DIR: dir, HOST: '127.0.0.1', PORT: '1', ...env }), { log: () => {} });

test('saves are debounced, atomic and private, and close() flushes them', () => {
  const dir = tmp();
  const db = openDb(dir);
  db.state.events.push({ id: 'a' });
  db.save();
  assert.equal(fs.existsSync(path.join(dir, 'db.json')), false, 'not written until the debounce fires');
  db.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).events, [{ id: 'a' }]);
  assert.equal(fs.existsSync(path.join(dir, 'db.json.tmp')), false);
  assert.equal(fs.statSync(path.join(dir, 'db.json')).mode & 0o777, 0o600);
  assert.equal(openDb(dir).state.events.length, 1);
});

test('a write failure is reported and retried, not fatal', () => {
  const dir = tmp();
  const logs = [];
  const db = openDb(dir, (m) => logs.push(m));
  fs.mkdirSync(path.join(dir, 'db.json')); // something in the way: rename onto a directory fails
  db.save();
  assert.equal(db.flush(), false);
  assert.match(logs[0], /Could not save data/);
  fs.rmdirSync(path.join(dir, 'db.json'));
  assert.equal(db.flush(), true);
  assert.ok(fs.statSync(path.join(dir, 'db.json')).isFile());
  db.close();
});

test('a damaged or too-new data file stops the app instead of being overwritten', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'db.json'), '{"version":2,"users":{');
  assert.throws(() => makeApp(dir), /not valid JSON.*backups/s);
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), '{"version":2,"users":{');
  fs.writeFileSync(path.join(dir, 'db.json'), '[1,2]');
  assert.throws(() => makeApp(dir), /unexpected format/);
  fs.writeFileSync(path.join(dir, 'db.json'), '{"version":99}');
  assert.throws(() => makeApp(dir), /newer version/);
});

test('the first release\'s password database is archived, not silently destroyed', () => {
  const dir = tmp();
  const old = JSON.stringify({ users: { bob: { username: 'bob', salt: 's', hash: 'h', classes: { A_1: { name: 'Math' } } } }, events: [{ id: 'x' }], today: {} });
  fs.writeFileSync(path.join(dir, 'db.json'), old);
  const logs = [];
  const db = openDb(dir, (m) => logs.push(m));
  assert.deepEqual(db.state.users, {});
  assert.deepEqual(db.state.events, []);
  const archived = fs.readdirSync(path.join(dir, 'backups')).find((n) => n.startsWith('db.old-format-'));
  assert.equal(fs.readFileSync(path.join(dir, 'backups', archived), 'utf8'), old);
  assert.match(logs[0], /Old data format/);
});

test('hand-edited files with wrong shapes are tolerated', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 2, users: [], sessions: 'x', events: {}, calendar: null }));
  const db = openDb(dir);
  assert.deepEqual(db.state.users, {}); assert.deepEqual(db.state.sessions, {}); assert.deepEqual(db.state.events, []);
  assert.equal(db.state.calendar.anchorLetter, 'A');
});

test('daily snapshots: one per day, no sessions inside, only the newest 7 kept', () => {
  const dir = tmp();
  const db = openDb(dir);
  db.state.sessions.abc = { userId: 'u', expires: 1 };
  const backups = path.join(dir, 'backups');
  for (let d = 1; d <= 9; d++) fs.writeFileSync(path.join(backups, `db-2020-01-0${d}.json`), '{}');
  fs.writeFileSync(path.join(backups, 'before-restore-keep.json'), '{}');
  const name = db.dailySnapshot();
  assert.match(name, /^db-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(db.dailySnapshot(), null, 'only one per day');
  const left = fs.readdirSync(backups).filter((n) => n.startsWith('db-')).sort();
  assert.equal(left.length, 7);
  assert.equal(left[left.length - 1], name);
  assert.ok(fs.existsSync(path.join(backups, 'before-restore-keep.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backups, name), 'utf8')).sessions, {});
  for (let i = 0; i < 5; i++) db.snapshot('before-restore');
  assert.ok(fs.readdirSync(backups).filter((n) => n.startsWith('before-restore-')).length <= 4);
});

test('startup housekeeping: old events and expired sessions go, recent ones stay', async () => {
  const dir = tmp();
  const t = today();
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    version: 2,
    users: {},
    sessions: { old: { userId: 'u', expires: 1 }, live: { userId: 'u', expires: Date.now() + 1e6 } },
    events: [
      { id: 'a', title: 'ancient', date: cal.addDays(t, -90), time: '', description: '', by: null },
      { id: 'b', title: 'recent', date: cal.addDays(t, -10), time: '', description: '', by: null },
      { id: 'c', title: 'future', date: cal.addDays(t, 10), time: '', description: '', by: null }
    ],
    calendar: {}
  }));
  const app = makeApp(dir, { PORT: String(await freePort()) });
  await app.listen();
  assert.deepEqual(app.state.events.map((e) => e.title), ['recent', 'future']);
  assert.deepEqual(Object.keys(app.state.sessions), ['live']);
  assert.ok(app.db.lastSnapshot());
  await app.close();
});

test('shutting down flushes pending changes', async () => {
  const ctx = await startApp();
  ctx.app.state.events.push({ id: 'zz', title: 'late write', date: today(), time: '', description: '', by: null });
  ctx.app.db.save();
  await ctx.app.close();
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'db.json'), 'utf8'));
  assert.ok(saved.events.some((e) => e.id === 'zz'));
});

// ---- the real entry point -----------------------------------------------------
function runServer(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, ...env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  return { child, exited, output: () => out };
}
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timed out');
}

test('server.js starts, warns about missing setup, answers health checks and exits cleanly on SIGTERM', async () => {
  const dir = tmp();
  const port = await freePort();
  const s = runServer({ PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir });
  await until(() => /listening/.test(s.output()));
  assert.match(s.output(), /GOOGLE_CLIENT_ID.*not set/);
  assert.match(s.output(), /ADMIN_EMAILS is empty/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  s.child.kill('SIGTERM');
  assert.deepEqual(await s.exited, { code: 0, sig: null });
  assert.ok(fs.existsSync(path.join(dir, 'db.json')));
});

test('server.js explains bad settings and exits non-zero', async () => {
  const bad = runServer({ DATA_DIR: tmp(), PUBLIC_URL: 'not a url' });
  assert.equal((await bad.exited).code, 1);
  assert.match(bad.output(), /PUBLIC_URL is not a valid URL/);
  const tz = runServer({ DATA_DIR: tmp(), SCHOOL_TZ: 'Mars/Phobos' });
  assert.equal((await tz.exited).code, 1);
  assert.match(tz.output(), /SCHOOL_TZ/);
  const port = await freePort();
  const a = runServer({ PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tmp() });
  await until(() => /listening/.test(a.output()));
  const b = runServer({ PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tmp() });
  assert.equal((await b.exited).code, 1);
  assert.match(b.output(), /Cannot listen/);
  a.child.kill('SIGTERM'); await a.exited;
});
