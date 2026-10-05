'use strict';
// HTTP app: security headers, Google sign-in, JSON API, static files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const cal = require('../public/js/calendar.js');
const { openDb } = require('./db');
const { createGoogle, AuthError, newPkce } = require('./google');
const {
  cleanText, randomId, sha256hex, safeEqual, hasOwn, newFriendCode, normalizeFriendCode,
  parseCookies, serializeCookie, RateLimiter
} = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MB = 1024 * 1024;
const MAX_FRIENDS = 150;
const MAX_SESSIONS_PER_USER = 10;
const EVENT_KEEP_DAYS = 60; // events older than this are removed automatically

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message) => new HttpError(400, message);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function createApp(config, { log = (...a) => console.log(new Date().toISOString(), ...a), fetchFn } = {}) {
  const db = openDb(config.dataDir, log);
  const state = db.state;
  const limiter = new RateLimiter();
  const loginKey = crypto.randomBytes(32); // signs the short-lived "sign-in in progress" cookie
  // __Host- cookies can't be set or overwritten from sibling subdomains (other sites hosted on the same domain).
  const SID = config.secure ? '__Host-mhs_sid' : 'mhs_sid';
  const PENDING = config.secure ? '__Host-mhs_login' : 'mhs_login';
  const google = config.google.clientId && config.google.clientSecret
    ? createGoogle(config.google, {
      redirectUri: `${config.publicUrl}/auth/google/callback`, allowedDomains: config.allowedDomains, fetchFn
    })
    : null;

  const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
      "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow' // a school's events and pages are not for search engines
  };
  if (config.secure) SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=15552000';

  // ---------- small helpers ----------
  const today = () => cal.schoolNow(config.tz).date;
  const isAdmin = (u) => !!u && config.adminEmails.has(u.email);
  const getUser = (id) => (typeof id === 'string' && hasOwn(state.users, id) ? state.users[id] : null);
  const userCount = () => Object.keys(state.users).length;

  function clientIp(req) {
    const fwd = config.trustProxy ? req.headers['x-real-ip'] : null;
    return String(fwd || req.socket.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 64);
  }
  function addCookie(res, value) {
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', prev ? [].concat(prev, value) : [value]);
  }
  const clearCookie = (res, name) => addCookie(res, serializeCookie(name, '', { maxAge: 0, secure: config.secure }));

  function sendJson(res, status, data, headers) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store', ...headers
    });
    res.end(body);
  }
  function redirect(res, location) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  }

  // Signed, tamper-proof blob for the sign-in cookie.
  const mac = (s) => crypto.createHmac('sha256', loginKey).update(s).digest('base64url');
  function sign(obj) {
    const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${body}.${mac(body)}`;
  }
  function unsign(str) {
    const [body, tag] = String(str || '').split('.');
    if (!body || !tag || !safeEqual(tag, mac(body))) return null;
    try {
      const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return obj && obj.exp > Date.now() ? obj : null;
    } catch { return null; }
  }
  // Only same-site page names (optionally with a short query) may be used as a post-sign-in destination.
  function safeNext(next) {
    return typeof next === 'string' && /^[a-z]+\.html(\?[A-Za-z0-9_=&.-]{0,100})?$/.test(next) ? `/${next}` : '/index.html';
  }

  // ---------- users, sessions ----------
  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[SID];
    if (!token || token.length > 100) return null;
    const hash = sha256hex(token);
    const s = hasOwn(state.sessions, hash) ? state.sessions[hash] : null;
    if (!s || s.expires < Date.now()) return null;
    return getUser(s.userId);
  }
  function createSession(req, res, user) {
    const old = parseCookies(req.headers.cookie)[SID];
    if (old) delete state.sessions[sha256hex(old)]; // never reuse a session across sign-ins
    const token = crypto.randomBytes(32).toString('base64url');
    state.sessions[sha256hex(token)] = { userId: user.id, expires: Date.now() + config.sessionDays * 864e5 };
    const mine = Object.entries(state.sessions).filter(([, s]) => s.userId === user.id).sort((a, b) => a[1].expires - b[1].expires);
    while (mine.length > MAX_SESSIONS_PER_USER) delete state.sessions[mine.shift()[0]];
    db.save();
    addCookie(res, serializeCookie(SID, token, { maxAge: config.sessionDays * 86400, secure: config.secure }));
  }
  function uniqueFriendCode() {
    for (;;) {
      const code = newFriendCode();
      if (!Object.values(state.users).some((u) => u.friendCode === code)) return code;
    }
  }
  function defaultName(claims) {
    const given = cleanText(claims.given_name, 30);
    const family = cleanText(claims.family_name, 30);
    if (given) return family ? `${given} ${Array.from(family)[0].toUpperCase()}.` : given;
    return cleanText(claims.name, 30).split(' ')[0] || 'Student';
  }
  function upsertUser(claims) {
    const email = claims.email.toLowerCase();
    let user = Object.values(state.users).find((u) => u.sub === claims.sub);
    const isNew = !user;
    if (!user) {
      if (userCount() >= config.maxUsers) throw new AuthError('user limit reached', 'full');
      user = {
        id: randomId(), sub: claims.sub, email, name: defaultName(claims), created: Date.now(), lastLogin: 0,
        classes: {}, friends: [], friendCode: uniqueFriendCode(), shareSchedule: true
      };
      state.users[user.id] = user;
    }
    user.email = email; // follows the Google account if the address changes
    user.lastLogin = Date.now();
    return { user, isNew };
  }
  function deleteUser(id) {
    delete state.users[id];
    for (const [h, s] of Object.entries(state.sessions)) if (s.userId === id) delete state.sessions[h];
    for (const u of Object.values(state.users)) u.friends = u.friends.filter((f) => f !== id);
    state.events = state.events.filter((e) => e.by !== id);
    db.save();
  }
  const profile = (u) => ({ id: u.id, name: u.name, admin: isAdmin(u), friendCode: u.friendCode, shareSchedule: u.shareSchedule });

  // ---------- validation ----------
  function cleanClasses(input) {
    if (!isPlainObject(input)) throw bad('Invalid classes');
    const out = {};
    for (const [key, c] of Object.entries(input)) {
      if (!/^[A-D]_[1-6]$/.test(key) || !isPlainObject(c)) continue;
      const name = cleanText(c.name, 60);
      if (!name) continue; // a blank name clears the slot
      out[key] = {
        name, teacher: cleanText(c.teacher, 60), room: cleanText(c.room, 20),
        color: typeof c.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color.toLowerCase() : '#4f7cff'
      };
    }
    return out;
  }
  // Returns the cleaned event fields or throws 400. `daysBack` = how far in the past a date may be.
  function cleanEventFields(b, daysBack = 7) {
    const title = cleanText(b.title, 120);
    if (!title) throw bad('Give the event a title');
    const date = typeof b.date === 'string' ? b.date : '';
    if (cal.parseDate(date) === null) throw bad('Pick a valid date');
    const t = today();
    if (date < cal.addDays(t, -daysBack) || date > cal.addDays(t, 365 * 3)) throw bad('That date is too far away');
    const time = typeof b.time === 'string' ? b.time : '';
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('Invalid time');
    return { title, date, time, description: cleanText(b.description, 500) };
  }
  const byDateTime = (a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`);

  // ---------- backup / restore ----------
  function exportData() {
    return {
      app: 'mhs-hub', version: 2, exportedAt: new Date().toISOString(),
      users: Object.values(state.users).map((u) => ({
        id: u.id, sub: u.sub, email: u.email, name: u.name, created: u.created, lastLogin: u.lastLogin,
        classes: u.classes, friends: u.friends, friendCode: u.friendCode, shareSchedule: u.shareSchedule
      })),
      events: state.events,
      calendar: state.calendar
    };
  }
  // Validates everything from the file as if it were fresh user input.
  function importData(data) {
    if (!isPlainObject(data) || data.app !== 'mhs-hub' || data.version !== 2) throw bad('That is not an MHS Hub backup file');
    if (!Array.isArray(data.users) || data.users.length > config.maxUsers) throw bad('The backup has an invalid user list');
    const users = {};
    const subs = new Set();
    const codes = new Set();
    const friendIds = {};
    for (const u of data.users) {
      if (!isPlainObject(u) || typeof u.id !== 'string' || !/^[0-9a-f]{16}$/.test(u.id) || hasOwn(users, u.id)) throw bad('The backup has an invalid user');
      const sub = typeof u.sub === 'string' ? u.sub.slice(0, 255) : '';
      const email = typeof u.email === 'string' ? u.email.toLowerCase().slice(0, 254) : '';
      if (!sub || !email || subs.has(sub)) throw bad('The backup has an invalid or duplicate user');
      subs.add(sub);
      let code = normalizeFriendCode(u.friendCode);
      if (code && codes.has(code)) code = null;
      if (code) codes.add(code);
      friendIds[u.id] = Array.isArray(u.friends) ? u.friends : [];
      users[u.id] = {
        id: u.id, sub, email, name: cleanText(u.name, 40) || 'Student', created: num(u.created), lastLogin: num(u.lastLogin),
        classes: cleanClasses(isPlainObject(u.classes) ? u.classes : {}), friends: [], friendCode: code, shareSchedule: u.shareSchedule !== false
      };
    }
    for (const u of Object.values(users)) {
      u.friends = [...new Set(friendIds[u.id].filter((f) => typeof f === 'string' && f !== u.id && hasOwn(users, f)))].slice(0, MAX_FRIENDS);
      while (!u.friendCode) {
        const c = newFriendCode();
        if (!codes.has(c)) { codes.add(c); u.friendCode = c; }
      }
    }
    const events = [];
    let dropped = 0;
    for (const e of Array.isArray(data.events) ? data.events.slice(0, config.maxEvents) : []) {
      try {
        if (!isPlainObject(e) || typeof e.id !== 'string' || !/^[0-9a-f]{16}$/.test(e.id)) throw bad('id');
        const f = cleanEventFields(e, EVENT_KEEP_DAYS);
        events.push({ id: e.id, ...f, by: hasOwn(users, e.by) ? e.by : null, created: num(e.created) });
      } catch { dropped++; }
    }
    db.snapshot('before-restore'); // the previous data stays recoverable
    state.users = users;
    state.events = events;
    state.calendar = cal.cleanCalendar(data.calendar, today());
    for (const [h, s] of Object.entries(state.sessions)) if (!hasOwn(users, s.userId)) delete state.sessions[h];
    db.save();
    return { users: data.users.length, events: events.length, droppedEvents: dropped };
  }

  // ---------- API routes ----------
  const routes = [];
  function route(method, pattern, opts, handler) {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    routes.push({ method, re, names, auth: opts.auth, maxBody: opts.maxBody, handler });
  }

  route('GET', '/api/health', { auth: 'none' }, () => ({ ok: true }));

  route('GET', '/api/me', { auth: 'none' }, ({ user }) => ({
    user: user ? profile(user) : null,
    config: { signIn: !!google, allowedDomains: config.allowedDomains, eventPosting: config.eventPosting, tz: config.tz }
  }));
  route('PUT', '/api/me', { auth: 'user' }, ({ user, body }) => {
    if (body.name !== undefined) {
      const name = cleanText(body.name, 40);
      if (!name) throw bad('Enter a name');
      user.name = name;
    }
    if (body.shareSchedule !== undefined) {
      if (typeof body.shareSchedule !== 'boolean') throw bad('Invalid setting');
      user.shareSchedule = body.shareSchedule;
    }
    db.save();
    return profile(user);
  });
  route('POST', '/api/me/friend-code', { auth: 'user' }, ({ user }) => {
    user.friendCode = uniqueFriendCode();
    db.save();
    return profile(user);
  });
  route('DELETE', '/api/me', { auth: 'user' }, ({ user, res }) => {
    log(`Account deleted by its owner: ${user.id}`);
    deleteUser(user.id);
    clearCookie(res, SID);
    return { ok: true };
  });
  route('POST', '/api/logout', { auth: 'none' }, ({ req, res }) => {
    const token = parseCookies(req.headers.cookie)[SID];
    if (token) { delete state.sessions[sha256hex(token)]; db.save(); }
    clearCookie(res, SID);
    return { ok: true };
  });

  route('GET', '/api/calendar', { auth: 'none' }, () => ({ tz: config.tz, serverTime: Date.now(), calendar: state.calendar }));

  route('GET', '/api/classes', { auth: 'user' }, ({ user }) => user.classes);
  route('PUT', '/api/classes', { auth: 'user' }, ({ user, body }) => {
    user.classes = cleanClasses(body);
    db.save();
    return user.classes;
  });

  // Events: anyone can read; the author's name is only shown to signed-in viewers.
  route('GET', '/api/events', { auth: 'none' }, ({ user }) => state.events.slice().sort(byDateTime).map((e) => ({
    id: e.id, title: e.title, date: e.date, time: e.time, description: e.description,
    by: user ? (getUser(e.by) ? getUser(e.by).name : 'Former student') : undefined,
    mine: !!user && (e.by === user.id || isAdmin(user))
  })));
  route('POST', '/api/events', { auth: 'user' }, ({ user, body }) => {
    if (config.eventPosting === 'admins' && !isAdmin(user)) throw new HttpError(403, 'Only admins can add events');
    const fields = cleanEventFields(body);
    if (state.events.length >= config.maxEvents) throw bad('The events board is full');
    if (!isAdmin(user) && !limiter.hit(`event:${user.id}`, 10, 86400e3)) throw new HttpError(429, 'You can add up to 10 events a day');
    const ev = { id: randomId(), ...fields, by: user.id, created: Date.now() };
    state.events.push(ev);
    db.save();
    return { id: ev.id };
  });
  route('DELETE', '/api/events/:id', { auth: 'user' }, ({ user, params }) => {
    const i = state.events.findIndex((e) => e.id === params.id);
    if (i < 0) throw new HttpError(404, 'Event not found');
    if (state.events[i].by !== user.id && !isAdmin(user)) throw new HttpError(403, 'You can only delete your own events');
    state.events.splice(i, 1);
    db.save();
    return { ok: true };
  });

  // Friends: you add someone with their private code; they must add you back.
  const findByCode = (code) => {
    const c = normalizeFriendCode(code);
    return c ? Object.values(state.users).find((u) => u.friendCode === c) || null : null;
  };
  route('GET', '/api/friends', { auth: 'user' }, ({ user }) => {
    const friends = [];
    const outgoing = [];
    const incoming = [];
    for (const id of user.friends) {
      const o = getUser(id);
      if (!o) continue;
      if (o.friends.includes(user.id)) friends.push({ id: o.id, name: o.name, classes: o.shareSchedule ? o.classes : null });
      else outgoing.push({ id: o.id, name: o.name });
    }
    for (const o of Object.values(state.users)) {
      if (o.friends.includes(user.id) && !user.friends.includes(o.id)) incoming.push({ id: o.id, name: o.name });
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    return { friends: friends.sort(byName), incoming: incoming.sort(byName), outgoing: outgoing.sort(byName) };
  });
  route('POST', '/api/friends/lookup', { auth: 'user' }, ({ user, body }) => {
    if (!limiter.hit(`flook:${user.id}`, 60, 3600e3)) throw new HttpError(429, 'Too many tries. Wait a bit and try again.');
    const other = findByCode(body.code);
    if (!other) throw new HttpError(404, 'No one has that code');
    if (other.id === user.id) throw bad("That's your own code");
    return { name: other.name };
  });
  route('POST', '/api/friends/request', { auth: 'user' }, ({ user, body }) => {
    if (!limiter.hit(`freq:${user.id}`, 30, 3600e3)) throw new HttpError(429, 'Too many requests. Wait a bit and try again.');
    const other = findByCode(body.code);
    if (!other) throw new HttpError(404, 'No one has that code');
    if (other.id === user.id) throw bad("That's your own code");
    if (!user.friends.includes(other.id)) {
      if (user.friends.length >= MAX_FRIENDS) throw bad('Your friend list is full');
      user.friends.push(other.id);
      db.save();
    }
    return { status: other.friends.includes(user.id) ? 'friends' : 'requested', name: other.name };
  });
  route('POST', '/api/friends/:id/accept', { auth: 'user' }, ({ user, params }) => {
    const other = getUser(params.id);
    if (!other || !other.friends.includes(user.id)) throw new HttpError(404, 'That request is gone');
    if (!user.friends.includes(other.id)) {
      if (user.friends.length >= MAX_FRIENDS) throw bad('Your friend list is full');
      user.friends.push(other.id);
      db.save();
    }
    return { ok: true };
  });
  // Unfriend, decline a request, or cancel one you sent.
  route('DELETE', '/api/friends/:id', { auth: 'user' }, ({ user, params }) => {
    const other = getUser(params.id);
    user.friends = user.friends.filter((f) => f !== params.id);
    if (other) other.friends = other.friends.filter((f) => f !== user.id);
    db.save();
    return { ok: true };
  });

  // Admin
  route('GET', '/api/admin/status', { auth: 'admin' }, () => ({
    publicUrl: config.publicUrl,
    redirectUri: `${config.publicUrl}/auth/google/callback`,
    signIn: !!google,
    allowedDomains: config.allowedDomains,
    admins: config.adminEmails.size,
    eventPosting: config.eventPosting,
    users: userCount(),
    events: state.events.length,
    lastSnapshot: db.lastSnapshot(),
    tz: config.tz,
    today: today(),
    secureCookies: config.secure
  }));
  route('GET', '/api/admin/users', { auth: 'admin' }, () => Object.values(state.users)
    .map((u) => ({ id: u.id, name: u.name, email: u.email, created: u.created, lastLogin: u.lastLogin, admin: isAdmin(u), friends: u.friends.length }))
    .sort((a, b) => b.lastLogin - a.lastLogin));
  route('DELETE', '/api/admin/users/:id', { auth: 'admin' }, ({ user, params }) => {
    const target = getUser(params.id);
    if (!target) throw new HttpError(404, 'No such user');
    if (target.id === user.id) throw bad('Use the Account page to delete your own account');
    log(`User ${target.id} removed by admin ${user.id}`);
    deleteUser(target.id);
    return { ok: true };
  });
  route('PUT', '/api/admin/calendar', { auth: 'admin' }, ({ body }) => {
    state.calendar = cal.cleanCalendar(body, today());
    db.save();
    return state.calendar;
  });
  route('GET', '/api/admin/backup', { auth: 'admin' }, ({ res }) => {
    const body = JSON.stringify(exportData());
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="mhs-hub-backup-${new Date().toISOString().slice(0, 10)}.json"`
    });
    res.end(body);
  });
  route('POST', '/api/admin/restore', { auth: 'admin', maxBody: 12 * MB }, ({ user, body }) => {
    const result = importData(body);
    log(`Data restored from a backup file by admin ${user.id}: ${result.users} users, ${result.events} events`);
    return result;
  });

  // ---------- request pipeline ----------
  function readJson(req, max) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let failed = false;
      req.on('data', (c) => {
        if (failed) return;
        size += c.length;
        if (size > max) { failed = true; chunks.length = 0; reject(new HttpError(413, 'That is too large to upload')); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (failed) return;
        if (!size) return resolve({});
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'JSON only'));
        let v;
        try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(bad('Invalid JSON')); }
        if (!isPlainObject(v)) return reject(bad('Expected a JSON object'));
        resolve(v);
      });
      req.on('error', reject);
    });
  }

  // State-changing requests must come from our own pages: a custom header (which
  // cross-site requests can't add without a CORS preflight we never approve), plus
  // a same-host Origin and a non-cross-site Fetch-Metadata check where browsers send them.
  function csrfCheck(req) {
    if (req.headers['x-requested-with'] !== 'mhs') throw new HttpError(403, 'Request blocked');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Request blocked');
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let host;
      try { host = new URL(origin).host.toLowerCase(); } catch { throw new HttpError(403, 'Request blocked'); }
      const ok = new Set([config.publicHost]);
      if (req.headers.host) ok.add(String(req.headers.host).toLowerCase());
      if (config.trustProxy && req.headers['x-forwarded-host']) ok.add(String(req.headers['x-forwarded-host']).toLowerCase());
      if (!ok.has(host)) throw new HttpError(403, 'Request blocked');
    }
  }

  async function handleApi(req, res, url) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (method !== 'GET') csrfCheck(req);
    let match = null;
    let pathExists = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathExists = true;
      if (r.method === method) { match = { r, m }; break; }
    }
    if (!match) throw new HttpError(pathExists ? 405 : 404, pathExists ? 'Method not allowed' : 'Not found');
    const { r, m } = match;
    const user = currentUser(req);
    if (r.auth !== 'none' && !user) throw new HttpError(401, 'Sign in first');
    if (r.auth === 'admin' && !isAdmin(user)) throw new HttpError(403, 'Admins only');
    if (method !== 'GET' && user && !limiter.hit(`write:${user.id}`, 120, 60e3)) throw new HttpError(429, 'Slow down a little');
    const params = {};
    try { r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); }); } catch { throw bad('Bad request'); }
    const body = method === 'POST' || method === 'PUT' ? await readJson(req, r.maxBody || 100 * 1024) : {};
    const result = await r.handler({ req, res, url, params, user, body });
    if (!res.writableEnded) sendJson(res, 200, result);
  }

  // ---------- Google sign-in ----------
  function authStart(req, res, url) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (!google) return redirect(res, '/login.html?error=config');
    if (!limiter.hit(`auth:${clientIp(req)}`, 300, 60e3)) return redirect(res, '/login.html?error=busy');
    const pkce = newPkce();
    const pending = {
      s: crypto.randomBytes(16).toString('base64url'), n: crypto.randomBytes(16).toString('base64url'),
      v: pkce.verifier, next: safeNext(url.searchParams.get('next')), exp: Date.now() + 10 * 60e3
    };
    addCookie(res, serializeCookie(PENDING, sign(pending), { maxAge: 600, secure: config.secure }));
    redirect(res, google.authUrl({ state: pending.s, nonce: pending.n, challenge: pkce.challenge }));
  }

  async function authCallback(req, res, url) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (!google) return redirect(res, '/login.html?error=config');
    const fail = (code) => { clearCookie(res, PENDING); return redirect(res, `/login.html?error=${code}`); };
    if (!limiter.hit(`auth:${clientIp(req)}`, 300, 60e3)) return fail('busy');

    const q = url.searchParams;
    if (q.get('error')) return fail(q.get('error') === 'access_denied' ? 'denied' : 'failed');
    const pending = unsign(parseCookies(req.headers.cookie)[PENDING]);
    const code = q.get('code');
    // The cookie ties this callback to the browser that started the sign-in (stops login CSRF).
    if (!pending || !safeEqual(q.get('state') || '', pending.s)) return fail('state');
    if (!code || code.length > 2048) return fail('failed');
    try {
      const claims = await google.verifyIdToken(await google.exchangeCode(code, pending.v), pending.n);
      if (!google.domainAllowed(claims)) {
        log(`Sign-in blocked: Google Workspace domain "${claims.hd || '(none: personal account)'}" is not in ALLOWED_DOMAINS (${config.allowedDomains.join(', ')})`);
        return fail('domain');
      }
      const { user, isNew } = upsertUser(claims);
      createSession(req, res, user);
      clearCookie(res, PENDING);
      log(`Signed in: user ${user.id}${isNew ? ' (new account)' : ''}`);
      return redirect(res, pending.next);
    } catch (e) {
      if (!(e instanceof AuthError)) log('Sign-in error:', e && e.stack || e);
      else log(`Sign-in failed: ${e.message}`);
      return fail(e instanceof AuthError ? e.code : 'failed');
    }
  }

  // ---------- static files ----------
  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { throw bad('Bad request'); }
    if (rel.includes('\0') || rel.includes('\\')) throw bad('Bad request');
    if (rel.endsWith('/')) rel += 'index.html';
    const candidates = [rel, `${rel}.html`]; // /events works as well as /events.html
    for (const c of candidates) {
      const file = path.join(PUBLIC_DIR, c);
      if (!file.startsWith(PUBLIC_DIR + path.sep) || path.basename(file).startsWith('.')) continue;
      let st;
      try { st = await fs.promises.stat(file); } catch { continue; }
      if (!st.isFile()) continue;
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag
      };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      const data = await fs.promises.readFile(file);
      res.writeHead(200, { ...headers, 'Content-Length': data.length });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
    // Not found: friendly page for browsers, plain status otherwise.
    if (String(req.headers.accept || '').includes('text/html')) {
      try {
        const page = await fs.promises.readFile(path.join(PUBLIC_DIR, '404.html'));
        res.writeHead(404, { 'Content-Type': MIME['.html'], 'Content-Length': page.length, 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : page);
      } catch { /* fall through */ }
    }
    throw new HttpError(404, 'Not found');
  }

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
    try {
      if (url.pathname === '/auth/google') return authStart(req, res, url);
      if (url.pathname === '/auth/google/callback') return await authCallback(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 413) res.setHeader('Connection', 'close'); // don't wait for the rest of the upload
        return sendJson(res, e.status, { error: e.message });
      }
      log('Unhandled error:', (e && e.stack) || e);
      if (!res.headersSent) return sendJson(res, 500, { error: 'Something went wrong on the server' });
      res.end();
    }
  }

  // ---------- lifecycle ----------
  function maintain() {
    const now = Date.now();
    for (const [h, s] of Object.entries(state.sessions)) if (s.expires < now) delete state.sessions[h];
    const cutoff = cal.addDays(today(), -EVENT_KEEP_DAYS);
    state.events = state.events.filter((e) => e.date >= cutoff);
    db.save();
    try { db.dailySnapshot(); } catch (e) { log(`Could not write the daily snapshot: ${e.message}`); }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { log('Fatal request error:', e); try { res.destroy(); } catch { /* already gone */ } });
  });
  // Longer than a proxy's idle timeout, so the proxy never reuses a connection we already closed.
  server.keepAliveTimeout = 65e3;
  server.headersTimeout = 70e3;
  server.requestTimeout = 120e3;
  let timer = null;

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        maintain();
        timer = setInterval(maintain, 6 * 3600e3);
        timer.unref();
        resolve(server.address().port);
      });
    });
  }
  function close() {
    return new Promise((resolve) => {
      if (timer) clearInterval(timer);
      const force = setTimeout(() => server.closeAllConnections(), 3000);
      force.unref();
      server.close(() => { clearTimeout(force); db.close(); resolve(); }); // also fires if it was never listening
      server.closeIdleConnections();
    });
  }

  return { server, listen, close, config, state, db, google: !!google };
}

module.exports = { createApp };
