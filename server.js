'use strict';
// MHS Hub server: static files + JSON API. No dependencies.
// All persistent data lives in $DATA_DIR/db.json (WebManager backs up /data).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ALLOW_REGISTRATION = (process.env.ALLOW_REGISTRATION || 'true') !== 'false';
const ADMIN_USERS = (process.env.ADMIN_USERS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const SESSION_DAYS = 30;
const MAX_BODY = 100 * 1024;

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {}, sessions: {}, events: [], today: { scheduleType: 'daily', dayLetter: 'A' }, friends: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch (e) {
  if (e.code !== 'ENOENT') { console.error('Cannot read db.json:', e.message); process.exit(1); }
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 50);
}
function saveNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- helpers ----------
const SCHEDULE_TYPES = ['daily', 'advisory', 'early_release'];
const id = () => crypto.randomBytes(8).toString('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(password, user) {
  const a = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  return crypto.timingSafeEqual(a, Buffer.from(user.hash, 'hex'));
}
function isAdmin(user) {
  if (!user) return false;
  if (ADMIN_USERS.length) return ADMIN_USERS.includes(user.username);
  return user.username === Object.keys(db.users)[0]; // no list set: first account
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).sid;
  const s = token && db.sessions[token];
  if (!s || s.expires < Date.now()) return null;
  return db.users[s.username] || null;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https'; }
function setSession(req, res, username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { username, expires: Date.now() + SESSION_DAYS * 864e5 };
  save();
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
}
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// crude brute-force throttle: 10 failed logins per IP per 15 min
const fails = new Map();
function clientIp(req) { return (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString(); }
function throttled(ip) {
  const f = fails.get(ip);
  return !!f && f.until > Date.now() && f.count >= 10;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || f.until < Date.now()) fails.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
  else f.count++;
}

function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, 'Sign in first');
  return u;
}
function areFriends(a, b) {
  return (db.friends[a] || []).includes(b) && (db.friends[b] || []).includes(a);
}
function cleanClasses(input) {
  const out = {};
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid classes');
  for (const [key, c] of Object.entries(input)) {
    if (!/^[A-D]_[1-6]$/.test(key) || !c || typeof c !== 'object') continue;
    const name = str(c.name, 60);
    if (!name) continue;
    out[key] = {
      name, teacher: str(c.teacher, 60), room: str(c.room, 20),
      color: /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#4f7cff'
    };
  }
  return out;
}

// ---------- API ----------
async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = clientIp(req);

  if (route === 'GET /api/health') return send(res, 200, { ok: true });

  if (route === 'GET /api/me') {
    const u = currentUser(req);
    return send(res, 200, { user: u ? { username: u.username, admin: isAdmin(u) } : null, registration: ALLOW_REGISTRATION });
  }

  if (route === 'POST /api/register') {
    if (!ALLOW_REGISTRATION) throw new HttpError(403, 'Registration is closed');
    const b = await readBody(req);
    const username = str(b.username, 20).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, 'Username: 3-20 letters, numbers or _');
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8-128 characters');
    if (db.users[username]) throw new HttpError(409, 'Username taken');
    db.users[username] = { username, ...hashPassword(password), created: Date.now(), classes: {} };
    setSession(req, res, username);
    return send(res, 200, { user: { username, admin: isAdmin(db.users[username]) } });
  }

  if (route === 'POST /api/login') {
    if (throttled(ip)) throw new HttpError(429, 'Too many attempts, try again later');
    const b = await readBody(req);
    const u = db.users[str(b.username, 20).toLowerCase()];
    if (!u || typeof b.password !== 'string' || !checkPassword(b.password, u)) {
      noteFail(ip);
      throw new HttpError(401, 'Wrong username or password');
    }
    setSession(req, res, u.username);
    return send(res, 200, { user: { username: u.username, admin: isAdmin(u) } });
  }

  if (route === 'POST /api/logout') {
    const t = parseCookies(req).sid;
    if (t) { delete db.sessions[t]; save(); }
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  // today (shared by everyone; admins set it)
  if (route === 'GET /api/today') return send(res, 200, db.today);
  if (route === 'PUT /api/today') {
    const u = requireUser(req);
    if (!isAdmin(u)) throw new HttpError(403, 'Only admins can change today\'s schedule');
    const b = await readBody(req);
    if (!SCHEDULE_TYPES.includes(b.scheduleType) || !['A', 'B', 'C', 'D'].includes(b.dayLetter)) throw new HttpError(400, 'Invalid schedule');
    db.today = { scheduleType: b.scheduleType, dayLetter: b.dayLetter };
    save();
    return send(res, 200, db.today);
  }

  // my classes
  if (route === 'GET /api/classes') return send(res, 200, requireUser(req).classes || {});
  if (route === 'PUT /api/classes') {
    const u = requireUser(req);
    u.classes = cleanClasses(await readBody(req));
    save();
    return send(res, 200, u.classes);
  }

  // events (public to read, signed-in to add)
  if (route === 'GET /api/events') {
    const me = currentUser(req);
    return send(res, 200, db.events.map(e => ({ ...e, mine: !!me && (e.by === me.username || isAdmin(me)) })));
  }
  if (route === 'POST /api/events') {
    const u = requireUser(req);
    const b = await readBody(req);
    const title = str(b.title, 120);
    const date = str(b.date, 10);
    const time = str(b.time, 5);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Title and date are required');
    if (time && !/^\d{2}:\d{2}$/.test(time)) throw new HttpError(400, 'Invalid time');
    if (db.events.length >= 2000) throw new HttpError(400, 'Too many events');
    const ev = { id: id(), title, date, time, description: str(b.description, 500), by: u.username };
    db.events.push(ev);
    save();
    return send(res, 200, ev);
  }
  let m = url.pathname.match(/^\/api\/events\/([0-9a-f]+)$/);
  if (m && req.method === 'DELETE') {
    const u = requireUser(req);
    const i = db.events.findIndex(e => e.id === m[1]);
    if (i < 0) throw new HttpError(404, 'Not found');
    if (db.events[i].by !== u.username && !isAdmin(u)) throw new HttpError(403, 'Not your event');
    db.events.splice(i, 1);
    save();
    return send(res, 200, { ok: true });
  }

  // friends
  if (route === 'GET /api/friends') {
    const u = requireUser(req);
    const mine = db.friends[u.username] || [];
    const friends = [], outgoing = [];
    for (const name of mine) {
      if (areFriends(u.username, name)) friends.push({ username: name, classes: db.users[name]?.classes || {} });
      else outgoing.push(name);
    }
    const incoming = Object.keys(db.friends).filter(n => (db.friends[n] || []).includes(u.username) && !mine.includes(n));
    return send(res, 200, { friends, incoming, outgoing });
  }
  m = url.pathname.match(/^\/api\/friends\/([a-z0-9_]{3,20})$/);
  if (m && req.method === 'POST') {
    const u = requireUser(req);
    const other = m[1];
    if (other === u.username || !db.users[other]) throw new HttpError(404, 'No such user');
    const list = db.friends[u.username] = db.friends[u.username] || [];
    if (!list.includes(other)) list.push(other);
    save();
    return send(res, 200, { ok: true });
  }
  if (m && req.method === 'DELETE') {
    const u = requireUser(req);
    const other = m[1];
    for (const [a, b] of [[u.username, other], [other, u.username]]) {
      if (db.friends[a]) db.friends[a] = db.friends[a].filter(n => n !== b);
    }
    save();
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found');
}

// ---------- static files ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon'
};
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(PUBLIC_DIR, p);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // CSRF guard: state-changing requests must be JSON, which cross-site forms can't send
        const ct = req.headers['content-type'] || '';
        if (req.method !== 'DELETE' && !ct.startsWith('application/json')) throw new HttpError(415, 'JSON only');
        if (req.headers['x-requested-with'] !== 'mhs') throw new HttpError(403, 'Bad request');
      }
      return await api(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

// expire old sessions hourly
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of Object.entries(db.sessions)) if (s.expires < now) delete db.sessions[t];
  save();
}, 3600e3).unref();

server.listen(PORT, HOST, () => console.log(`MHS Hub listening on ${HOST}:${PORT}, data in ${DATA_DIR}`));

function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
