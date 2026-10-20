'use strict';
// HTTP app: security headers, Google sign-in, JSON API, static files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const cal = require('../public/js/calendar.js');
const bell = require('../public/js/bellSchedule.js');
const avatars = require('../public/js/avatars.js');
const { openDb } = require('./db');
const { openSecretBox } = require('./secretbox');
const { openAudit } = require('./audit');
const { createGoogle, AuthError, newPkce } = require('./google');
const { createMenu } = require('./menu');
const { createFilter } = require('./wordfilter');
const {
  cleanText, randomId, sha256hex, safeEqual, hasOwn, newFriendCode, normalizeFriendCode,
  parseCookies, serializeCookie, RateLimiter
} = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MB = 1024 * 1024;
const MAX_FRIENDS = 150;
const MAX_SESSIONS_PER_USER = 10;
// What a friend may see of your schedule: everything, only which lunch you have, or nothing.
const SHARE_LEVELS = ['full', 'lunch', 'none'];
const SUGGEST_KEYS = ['show', 'viaFriends', 'viaClasses'];
const GRADES = [9, 10, 11, 12];
const MAX_LINKS = 100;
const MAX_HIDDEN_SUGGESTIONS = 300;
// Starting list for the Links page (admins can change it). All from the MHS and district websites.
const DEFAULT_LINKS = [
  ['Tickets & events', 'MHS events ticketing', 'https://www.justagame.com/clients/12_caXiG', 'Buy tickets for games, concerts and other MHS events.'],
  ['Tickets & events', 'Athletic schedules', 'https://www.gobound.com/wi/schools/mukwonago', 'Game times and results for every MHS team.'],
  ['Tickets & events', 'Classic 8 conference', 'https://www.gobound.com/wi/conferences/classiceight', ''],
  ['Activities', 'Athletics & Activities', 'https://mhs.masd.k12.wi.us/Athletics--Activities/index.html', 'Teams, clubs and how to join.'],
  ['Activities', 'Booster Club', 'https://mhs.masd.k12.wi.us/Athletics--Activities/Athletics/Booster-Club/index.html', ''],
  ['Activities', 'Fine Arts', 'https://mhs.masd.k12.wi.us/Athletics--Activities/Activities/Fine-Arts/index.html', ''],
  ['School', 'Infinite Campus', 'https://mukwonagowi.infinitecampus.org/campus/portal/mukwonago.jsp', 'Grades, attendance and your official schedule.'],
  ['School', 'MHS calendar', 'https://mhs.masd.k12.wi.us/__catapult_pages/78502d00-3dcd-46f6-ad44-e5e7a9b512ad/Calendar.html', ''],
  ['School', 'Lunch menu', 'https://menus.healthepro.com/organizations/2534/sites/15466/menus/133305', "This week's high school lunches."],
  ['Counseling', 'Counseling', 'https://mhs.masd.k12.wi.us/Academics/Counseling/index.html', ''],
  ['Counseling', 'Course registration', 'https://mhs.masd.k12.wi.us/Academics/Counseling/Course-Registration/index.html', ''],
  ['Counseling', 'Scholarships & financial aid', 'https://mhs.masd.k12.wi.us/Academics/Counseling/Scholarships-and-Financial-Aid/index.html', '']
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message) => new HttpError(400, message);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function createApp(config, { log = (...a) => console.log(new Date().toISOString(), ...a), fetchFn } = {}) {
  const db = openDb(config.dataDir, log);
  const auditLog = openAudit(config.dataDir, log); // kept forever; the school can see it if needed (src/audit.js)
  const secrets = openSecretBox(config.dataDir); // encrypts Google Tasks tokens at rest
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
      "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow' // a school's events and pages are not for search engines
  };
  if (config.secure) SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=15552000';
  const menu = createMenu({ district: config.menu.district, menuId: config.menu.id, site: config.menu.site, fetchFn, log });
  const filter = createFilter(() => state.blockedWords || []);
  // Throws 400 if anything a student typed has a word that doesn't belong on a school site.
  function checkWords(...texts) {
    const w = filter.find(...texts);
    if (w) throw bad(`Please keep it school-appropriate ("${w}" isn't allowed here)`);
  }

  // ---------- small helpers ----------
  const today = () => cal.schoolNow(config.tz).date;
  // Owners are the ADMIN_EMAILS (always admins, can't be removed in the app); other admins are
  // people an admin promoted on the Admin page.
  const isOwner = (u) => !!u && config.adminEmails.has(u.email);
  const isAdmin = (u) => isOwner(u) || (!!u && u.adminGranted === true);
  // Events go on a board everyone sees, so by default only people an admin has verified may post.
  const canPostEvents = (u) => !!u && (isAdmin(u) || config.eventPosting === 'everyone' || (config.eventPosting === 'verified' && u.verified === true));
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
  // First and last name from Google. They are private: only name search and admins use them.
  function googleNames(claims) {
    let given = cleanText(claims.given_name, 30);
    let family = cleanText(claims.family_name, 40);
    if (!given) {
      const [first = '', ...rest] = cleanText(claims.name, 70).split(' ');
      given = first; family = rest.join(' ');
    }
    return { givenName: cleanText(given, 30), familyName: cleanText(family, 40) };
  }
  // Display name: first name + last initial ("Ann L.").
  function nameFrom(given, family) {
    if (given) return family ? `${given} ${Array.from(family)[0].toUpperCase()}.` : given;
    return 'Student';
  }
  // Fields added after the first release get their defaults (old db.json files, backups).
  // What a reset profile goes back to: Google first name and last initial, nothing else.
  const resetFields = (u) => ({ name: nameFrom(u.givenName, u.familyName), grade: null, bio: '', pronouns: '', interests: [], avatar: avatars.clean(null) });
  // Everyone agrees to the Privacy & Terms page before using the site; a new version asks again.
  // Change TERMS_VERSION (and the date on public/terms.html) whenever that page changes.
  const TERMS_VERSION = '2026-10-20';
  let feedbackFeature = null, photosFeature = null; // set up with the other features below
  const agreedNow = (u) => !!u && isPlainObject(u.agreed) && u.agreed.version === TERMS_VERSION;
  function fillUserDefaults(u) {
    if (typeof u.givenName !== 'string') u.givenName = '';
    if (typeof u.familyName !== 'string') u.familyName = '';
    if (typeof u.searchable !== 'boolean') u.searchable = true;
    if (!isPlainObject(u.shareLevels)) u.shareLevels = {};
    if (!SHARE_LEVELS.includes(u.shareDefault)) u.shareDefault = 'full';
    // People you may know: whether you see suggestions, and how others may be shown you
    // (before these settings, only people in name search were suggested)
    if (!isPlainObject(u.suggest)) u.suggest = { show: true, viaFriends: u.searchable, viaClasses: u.searchable };
    for (const k of SUGGEST_KEYS) if (typeof u.suggest[k] !== 'boolean') u.suggest[k] = true;
    if (!GRADES.includes(u.grade)) u.grade = null;
    if (typeof u.bio !== 'string') u.bio = '';
    if (typeof u.profileLocked !== 'boolean') u.profileLocked = false;
    if (typeof u.adminGranted !== 'boolean') u.adminGranted = false;
    if (typeof u.pronouns !== 'string') u.pronouns = '';
    if (!Array.isArray(u.interests)) u.interests = [];
    u.avatar = avatars.clean(u.avatar);
    if (!Array.isArray(u.hiddenSuggestions)) u.hiddenSuggestions = [];
    return u;
  }
  for (const u of Object.values(state.users)) fillUserDefaults(u);

  function upsertUser(claims) {
    const email = claims.email.toLowerCase();
    let user = Object.values(state.users).find((u) => u.sub === claims.sub);
    if (user && user.archived) throw new AuthError('account archived after graduation', 'archived');
    const isNew = !user;
    const names = googleNames(claims);
    if (!user) {
      if (userCount() >= config.maxUsers) throw new AuthError('user limit reached', 'full');
      user = fillUserDefaults({
        id: randomId(), sub: claims.sub, email, name: nameFrom(names.givenName, names.familyName), created: Date.now(), lastLogin: 0,
        classes: {}, friends: [], friendCode: uniqueFriendCode(), shareSchedule: true, verified: false
      });
      state.users[user.id] = user;
    }
    user.email = email; // follows the Google account if the address changes
    Object.assign(user, names);
    user.lastLogin = Date.now();
    return { user, isNew };
  }
  function deleteUser(id) {
    const gone = state.users[id];
    delete state.users[id];
    for (const [h, s] of Object.entries(state.sessions)) if (s.userId === id) delete state.sessions[h];
    for (const u of Object.values(state.users)) {
      u.friends = u.friends.filter((f) => f !== id);
      delete u.shareLevels[id];
      u.hiddenSuggestions = u.hiddenSuggestions.filter((f) => f !== id);
    }
    for (const f of features) f.forgetUser(id, gone);
    db.save();
  }
  const profile = (u) => ({
    id: u.id, name: u.name, admin: isAdmin(u), owner: isOwner(u), verified: u.verified === true, canPostEvents: canPostEvents(u),
    friendCode: u.friendCode, shareSchedule: u.shareSchedule, searchable: u.searchable,
    shareDefault: u.shareDefault, suggest: { ...u.suggest }, hiddenSuggestions: u.hiddenSuggestions.length,
    grade: u.grade, bio: u.bio, profileLocked: u.profileLocked, pronouns: u.pronouns, interests: u.interests, avatar: u.avatar,
    mustAgree: !agreedNow(u), termsVersion: TERMS_VERSION,
    photo: photoUrl(u), pendingPhoto: isPlainObject(u.photo) && u.photo.pending ? `/photos/${u.photo.pending}.jpg` : null,
    unreadFeedback: feedbackFeature ? feedbackFeature.unreadFor(u) : 0
  });
  // What anyone signed in may see of someone (search results, suggestions, requests).
  // an approved profile photo, if they have one (src/photos.js)
  const photoUrl = (u) => (isPlainObject(u.photo) && u.photo.approved ? `/photos/${u.photo.approved}.jpg` : null);
  const publicCard = (u) => ({ id: u.id, name: u.name, grade: u.grade, avatar: u.avatar, photo: photoUrl(u) });
  // Ids of people who are friends with `u` both ways.
  const confirmedFriends = (u) => u.friends.filter((id) => { const o = getUser(id); return o && !o.archived && o.friends.includes(u.id); });
  // What friends see: the card plus the rest of the profile.
  const friendCard = (u) => ({ ...publicCard(u), bio: u.bio, pronouns: u.pronouns, interests: u.interests });
  // What `owner` lets `viewer` (a friend) see. The Account page's master switch turns everything off.
  const shareLevel = (owner, viewerId) => (!owner.shareSchedule ? 'none' : owner.shareLevels[viewerId] || owner.shareDefault);
  // Lunch letter for each day letter, for friends who see only lunch.
  const lunchesOf = (u) => Object.fromEntries(cal.LETTERS.map((l) => [l, bell.lunchFor(u.classes, l)]).filter(([, v]) => v));

  // ---------- validation ----------
  // Classes are keyed by color block: { yellow: { name, teacher, room }, green: { ..., lunch: 'A' } },
  // plus `advisory` ({ name, teacher, room }; the name defaults to "Advisory").
  // The first release keyed them by day and hour ('A_1'); those are moved to the block that meets
  // then (a block that is already set wins, then the earliest day).
  const LEGACY_KEY = /^[A-D]_[1-6]$/;
  function cleanClasses(input) {
    if (!isPlainObject(input)) throw bad('Invalid classes');
    const out = {};
    const keys = [...[...bell.BLOCK_KEYS, bell.ADVISORY].filter((k) => hasOwn(input, k)), ...Object.keys(input).filter((k) => LEGACY_KEY.test(k)).sort()];
    for (const key of keys) {
      const block = LEGACY_KEY.test(key) ? bell.blockFor(key[0], Number(key[2])) : key;
      const c = input[key];
      if (hasOwn(out, block) || !isPlainObject(c)) continue;
      const teacher = cleanText(c.teacher, 60), room = cleanText(c.room, 20);
      const name = cleanText(c.name, 60) || (block === bell.ADVISORY && (teacher || room) ? 'Advisory' : '');
      if (!name) continue; // a blank name clears the block
      out[block] = { name, teacher, room };
      if (bell.LUNCH_BLOCKS.includes(block) && bell.LUNCH_NAMES.includes(c.lunch)) out[block].lunch = c.lunch;
    }
    return out;
  }
  // Schedules saved by the first release are converted once, at startup.
  {
    let converted = 0;
    for (const u of Object.values(state.users)) {
      if (isPlainObject(u.classes) && Object.keys(u.classes).some((k) => LEGACY_KEY.test(k))) { u.classes = cleanClasses(u.classes); converted++; }
    }
    if (converted) { log(`Converted ${converted} saved schedule${converted === 1 ? '' : 's'} to color blocks`); db.save(); }
  }
  function cleanGrade(v) {
    if (v === null || v === '') return null;
    const g = typeof v === 'string' && /^\d{1,2}$/.test(v) ? Number(v) : v;
    if (!GRADES.includes(g)) throw bad('Pick a grade from 9 to 12');
    return g;
  }
  // Profile fields anyone may send (name, grade, bio). Returns only the ones present.
  function cleanProfileFields(b) {
    const out = {};
    if (b.name !== undefined) {
      out.name = cleanText(b.name, 40);
      if (!out.name) throw bad('Enter a name');
    }
    if (b.grade !== undefined) out.grade = cleanGrade(b.grade);
    if (b.bio !== undefined) {
      if (typeof b.bio !== 'string') throw bad('Invalid bio');
      out.bio = cleanText(b.bio, 160);
    }
    if (b.pronouns !== undefined) {
      if (typeof b.pronouns !== 'string') throw bad('Invalid pronouns');
      out.pronouns = cleanText(b.pronouns, 20);
    }
    if (b.interests !== undefined) {
      if (!Array.isArray(b.interests) || b.interests.length > 10) throw bad('Invalid interests');
      const seen = new Set();
      out.interests = [];
      for (const i of b.interests) {
        const t = cleanText(i, 24);
        if (!t || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        out.interests.push(t);
      }
      if (out.interests.length > 5) throw bad('Pick up to 5 interests');
    }
    if (b.avatar !== undefined) {
      if (!isPlainObject(b.avatar)) throw bad('Invalid avatar');
      out.avatar = avatars.clean(b.avatar);
    }
    return out;
  }
  const { sameClass } = bell; // same name, same teacher (by last name) when both have one
  // Admin-managed links: validated like any user input; returns null for an invalid entry.
  // An http(s) address, normalized, or null.
  function cleanUrl(v) {
    const s = typeof v === 'string' ? v.trim() : '';
    let u;
    try { u = new URL(s); } catch { return null; }
    return s.length <= 500 && (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
  }
  function cleanLink(l) {
    if (!isPlainObject(l)) return null;
    const title = cleanText(l.title, 80);
    const url = cleanUrl(l.url);
    if (!title || !url) return null;
    return {
      id: typeof l.id === 'string' && /^[0-9a-f]{16}$/.test(l.id) ? l.id : randomId(),
      title, url, category: cleanText(l.category, 40) || 'Other', description: cleanText(l.description, 160)
    };
  }
  if (!Array.isArray(state.links)) {
    state.links = DEFAULT_LINKS.map(([category, title, url, description]) => cleanLink({ category, title, url, description }));
    db.save();
  } else {
    state.links = state.links.map(cleanLink).filter(Boolean).slice(0, MAX_LINKS);
    // the first default lunch link pointed at the whole district; point it at the high school menu
    const old = state.links.find((l) => l.url === 'https://www.myschoolmenus.com/organizations/2534');
    if (old) { Object.assign(old, { title: 'Lunch menu', url: 'https://menus.healthepro.com/organizations/2534/sites/15466/menus/133305', description: old.description || "This week's high school lunches." }); db.save(); }
  }
  // Lowercase, accents removed, only letters/digits: 'José O\'Neil' -> ['jose', 'oneil']
  const nameWords = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/['\u2019.]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);


  // ---------- backup / restore ----------
  function exportData() {
    return {
      // 'mhs-hub' is the file format's id from before the rename: kept so old backups still restore
      app: 'mhs-hub', version: 2, exportedAt: new Date().toISOString(),
      users: Object.values(state.users).map((u) => ({
        id: u.id, sub: u.sub, email: u.email, name: u.name, created: u.created, lastLogin: u.lastLogin,
        classes: u.classes, friends: u.friends, friendCode: u.friendCode, shareSchedule: u.shareSchedule, verified: u.verified === true,
        givenName: u.givenName, familyName: u.familyName, searchable: u.searchable, shareLevels: u.shareLevels, shareDefault: u.shareDefault, suggest: u.suggest,
        grade: u.grade, bio: u.bio, profileLocked: u.profileLocked, adminGranted: u.adminGranted,
        pronouns: u.pronouns, interests: u.interests, avatar: u.avatar, hiddenSuggestions: u.hiddenSuggestions,
        calendarToken: u.calendarToken, agreed: u.agreed, photo: u.photo, archived: u.archived
      })),
      events: state.events,
      calendar: state.calendar,
      links: state.links,
      ...Object.assign({}, ...features.map((f) => f.exportData()))
    };
  }
  // Validates everything from the file as if it were fresh user input.
  function importData(data) {
    if (!isPlainObject(data) || data.app !== 'mhs-hub' || data.version !== 2) throw bad('That is not an MHS Today backup file');
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
      users[u.id] = fillUserDefaults({
        id: u.id, sub, email, name: cleanText(u.name, 40) || 'Student', created: num(u.created), lastLogin: num(u.lastLogin),
        classes: cleanClasses(isPlainObject(u.classes) ? u.classes : {}), friends: [], friendCode: code, shareSchedule: u.shareSchedule !== false,
        verified: u.verified === true, givenName: cleanText(u.givenName, 30), familyName: cleanText(u.familyName, 40),
        searchable: u.searchable !== false, grade: GRADES.includes(u.grade) ? u.grade : null, bio: cleanText(u.bio, 160),
        shareDefault: u.shareDefault, suggest: isPlainObject(u.suggest) ? Object.fromEntries(SUGGEST_KEYS.map((k) => [k, u.suggest[k] !== false])) : undefined,
        profileLocked: u.profileLocked === true, adminGranted: u.adminGranted === true, avatar: avatars.clean(u.avatar),
        photo: isPlainObject(u.photo) ? u.photo : null // checked against the files by src/photos.js
      });
      try {
        Object.assign(users[u.id], cleanProfileFields({
          pronouns: typeof u.pronouns === 'string' ? u.pronouns : '',
          interests: Array.isArray(u.interests) ? u.interests.slice(0, 5) : []
        }));
      } catch { /* keep the defaults */ }
      if (typeof u.calendarToken === 'string' && /^[0-9a-f]{48}$/.test(u.calendarToken)) users[u.id].calendarToken = u.calendarToken;
      if (isPlainObject(u.agreed) && typeof u.agreed.version === 'string' && u.agreed.version.length <= 20) users[u.id].agreed = { version: u.agreed.version, at: num(u.agreed.at) };
      if (isPlainObject(u.archived)) users[u.id].archived = { at: num(u.archived.at), deleteAfter: num(u.archived.deleteAfter) };
      users[u.id].rawHidden = Array.isArray(u.hiddenSuggestions) ? u.hiddenSuggestions : [];
      users[u.id].rawLevels = isPlainObject(u.shareLevels) ? u.shareLevels : {};
    }
    for (const u of Object.values(users)) {
      u.friends = [...new Set(friendIds[u.id].filter((f) => typeof f === 'string' && f !== u.id && hasOwn(users, f)))].slice(0, MAX_FRIENDS);
      for (const f of u.friends) if (hasOwn(u.rawLevels, f) && SHARE_LEVELS.includes(u.rawLevels[f]) && u.rawLevels[f] !== u.shareDefault) u.shareLevels[f] = u.rawLevels[f];
      delete u.rawLevels;
      u.hiddenSuggestions = [...new Set(u.rawHidden.filter((f) => typeof f === 'string' && f !== u.id && hasOwn(users, f)))].slice(0, MAX_HIDDEN_SUGGESTIONS);
      delete u.rawHidden;
      while (!u.friendCode) {
        const c = newFriendCode();
        if (!codes.has(c)) { codes.add(c); u.friendCode = c; }
      }
    }
    // Google Tasks connections aren't in backups; keep the ones this server already has
    const bySub = new Map(Object.values(state.users).map((u) => [u.sub, u]));
    for (const u of Object.values(users)) {
      const old = bySub.get(u.sub);
      if (old && old.googleTasks) u.googleTasks = old.googleTasks;
    }
    db.snapshot('before-restore'); // the previous data stays recoverable
    state.users = users;
    const counts = Object.assign({ events: 0, droppedEvents: 0 }, ...features.map((f) => f.importData(data, users) || {}));
    state.calendar = cal.cleanCalendar(data.calendar, today());
    if (Array.isArray(data.links)) state.links = data.links.map(cleanLink).filter(Boolean).slice(0, MAX_LINKS);
    for (const [h, s] of Object.entries(state.sessions)) if (!hasOwn(users, s.userId)) delete state.sessions[h];
    db.save();
    return { users: data.users.length, events: counts.events, droppedEvents: counts.droppedEvents };
  }

  // ---------- API routes ----------
  const routes = [];
  const features = []; // study sessions, Google Tasks, groups (and events), tools...: see below
  function route(method, pattern, opts, handler) {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    // audit: false = not worth recording (look-ups, push settings); auditBody: false = record that it
    // happened but not what was sent (a whole backup file, someone's private Google Tasks)
    routes.push({ method, pattern, re, names, auth: opts.auth, maxBody: opts.maxBody, audit: opts.audit !== false, auditBody: opts.auditBody !== false, handler });
  }
  // The audit log: every change anyone makes, sign-ins, and refused admin attempts.
  const actorOf = (u) => (u ? { id: u.id, name: u.name, email: u.email } : null);
  function audit(action, req, user, { target = null, detail = null } = {}) {
    auditLog.record(action, { actor: actorOf(user), target, detail, ip: req ? clientIp(req) : null });
  }
  function auditDetail(body) {
    if (!isPlainObject(body) || !Object.keys(body).length) return null;
    const text = JSON.stringify(body);
    return text.length <= 2000 ? body : `${text.slice(0, 2000)}… (${text.length} characters)`;
  }

  // Feature modules add their own routes and say how to back up, restore and tidy their data, and
  // what to remove when someone deletes their account.
  const shared = {
    route, state, db, log, config, HttpError, bad, isAdmin, getUser, canPostEvents, cleanText, cleanUrl, randomId, limiter,
    today, cal, bell, sameClass, isPlainObject, hasOwn, num, publicCard, confirmedFriends, checkWords, features, fetchFn, google, secrets,
    // notify(userIds, kind, { title, body, url }): push notifications (set up by src/push.js below)
    notify: (...a) => (push ? push.notify(...a) : undefined)
  };
  let push = null;
  // reports first: the other features register what can be reported
  const reports = require('./reports')(shared);
  shared.reports = reports;
  reports.register('profile', {
    hide: false, // a reported profile stays up; an admin can reset it
    locate(ref, user) {
      const t = typeof ref.id === 'string' ? getUser(ref.id) : null;
      return t ? { id: t.id, ref: { id: t.id }, author: t.id, summary: [t.name, t.pronouns, t.bio, t.interests.join(', ')].filter(Boolean).join(' · '), link: '' } : null;
    },
    remove(ref) { const t = getUser(ref.id); if (t) { Object.assign(t, resetFields(t)); photosFeature.clear(t); db.save(); } },
    exists: (ref) => !!getUser(ref.id)
  });
  const calendarFeed = require('./icalendar')(shared);
  const tasks = require('./tasks')(shared);
  feedbackFeature = require('./feedback')(shared);
  photosFeature = require('./photos')(shared);
  features.push(reports, require('./study')(shared), require('./classevents')(shared), tasks, require('./groups')(shared), require('./tools')(shared), require('./notices')(shared), feedbackFeature, photosFeature, calendarFeed);
  push = require('./push')(shared);
  features.push(push);
  for (const f of features) if (f.upgrade) f.upgrade();

  route('GET', '/api/health', { auth: 'none' }, () => ({ ok: true }));

  route('GET', '/api/me', { auth: 'none' }, ({ user }) => ({
    user: user ? profile(user) : null,
    config: { signIn: !!google, allowedDomains: config.allowedDomains, eventPosting: config.eventPosting, tz: config.tz, assignments: tasks.enabled }
  }));
  route('PUT', '/api/me', { auth: 'user' }, ({ user, body }) => {
    const fields = cleanProfileFields(body);
    checkWords(fields.name, fields.bio, fields.pronouns, fields.interests || []);
    if (Object.keys(fields).length && user.profileLocked) throw new HttpError(403, 'An admin has locked your profile, so it can\'t be changed right now');
    for (const k of ['shareSchedule', 'searchable']) {
      if (body[k] !== undefined && typeof body[k] !== 'boolean') throw bad('Invalid setting');
    }
    if (body.shareDefault !== undefined && !SHARE_LEVELS.includes(body.shareDefault)) throw bad('Invalid setting');
    if (body.suggest !== undefined && (!isPlainObject(body.suggest) || Object.entries(body.suggest).some(([k, v]) => !SUGGEST_KEYS.includes(k) || typeof v !== 'boolean'))) throw bad('Invalid setting');
    Object.assign(user, fields);
    if (body.shareSchedule !== undefined) user.shareSchedule = body.shareSchedule;
    if (body.searchable !== undefined) user.searchable = body.searchable;
    if (body.shareDefault !== undefined) {
      user.shareDefault = body.shareDefault;
      // a friend set to the new default just follows it from now on
      for (const [id, level] of Object.entries(user.shareLevels)) if (level === user.shareDefault) delete user.shareLevels[id];
    }
    if (body.suggest !== undefined) Object.assign(user.suggest, body.suggest);
    db.save();
    return profile(user);
  });
  route('POST', '/api/me/friend-code', { auth: 'user' }, ({ user }) => {
    user.friendCode = uniqueFriendCode();
    db.save();
    return profile(user);
  });
  route('POST', '/api/me/agree', { auth: 'user' }, ({ user, body }) => {
    if (body.version !== TERMS_VERSION) throw bad('Reload the page to see the latest Privacy & Terms');
    user.agreed = { version: TERMS_VERSION, at: Date.now() };
    db.save();
    return profile(user);
  });
  // Everything the site keeps about you, as one file (Privacy page → Download my data).
  route('GET', '/api/me/export', { auth: 'user' }, ({ user, res }) => {
    const friends = confirmedFriends(user).map(getUser).filter(Boolean).map((f) => f.name);
    const data = Object.assign({
      exported: new Date().toISOString(),
      account: { ...profile(user), email: user.email, created: user.created, lastLogin: user.lastLogin, agreed: user.agreed || null },
      classes: user.classes, friends, calendarLink: !!user.calendarToken
    }, ...features.map((f) => (f.userData ? f.userData(user) : {})));
    const body = JSON.stringify(data, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="my-mhs-today-data.json"'
    });
    res.end(body);
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

  // Lunch menu for a day (default today). The server fetches it so pages never talk to other sites.
  route('GET', '/api/lunch', { auth: 'none' }, async ({ url }) => {
    const t = today();
    const date = url.searchParams.get('date') || t;
    if (cal.parseDate(date) === null || date < cal.addDays(t, -60) || date > cal.addDays(t, 60)) throw bad('Pick a date within two months');
    return { ...(await menu.day(date)), source: menu.pageUrl };
  });

  route('GET', '/api/links', { auth: 'none' }, () => state.links);

  route('GET', '/api/classes', { auth: 'user' }, ({ user }) => user.classes);
  route('PUT', '/api/classes', { auth: 'user' }, ({ user, body }) => {
    user.classes = cleanClasses(body);
    db.save();
    return user.classes;
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
      if (!o || o.archived) continue; // archived at graduation: hidden (they come back if restored)
      if (o.friends.includes(user.id)) {
        const level = shareLevel(o, user.id);
        friends.push({
          ...friendCard(o),
          level, // what they share with you
          myLevel: user.shareLevels[o.id] || user.shareDefault, // what you share with them (before your master switch)
          classes: level === 'full' ? o.classes : null,
          lunches: level === 'lunch' ? lunchesOf(o) : null
        });
      } else outgoing.push(publicCard(o));
    }
    for (const o of Object.values(state.users)) {
      if (!o.archived && o.friends.includes(user.id) && !user.friends.includes(o.id)) incoming.push(publicCard(o));
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    return { friends: friends.sort(byName), incoming: incoming.sort(byName), outgoing: outgoing.sort(byName) };
  });
  route('POST', '/api/friends/lookup', { auth: 'user', audit: false }, ({ user, body }) => {
    if (!limiter.hit(`flook:${user.id}`, 60, 3600e3)) throw new HttpError(429, 'Too many tries. Wait a bit and try again.');
    const other = findByCode(body.code);
    if (!other) throw new HttpError(404, 'No one has that code');
    if (other.id === user.id) throw bad("That's your own code");
    return { name: other.name };
  });
  // Name search: every word typed must start one of the person's names. Only people who allow it
  // are found, and results show the display name, never the full name or email.
  route('POST', '/api/friends/search', { auth: 'user', audit: false }, ({ user, body }) => {
    const words = nameWords(cleanText(body.q, 60)).slice(0, 4);
    if (words.join('').length < 2) throw bad('Type at least two letters of a name');
    if (!limiter.hit(`fsearch:${user.id}`, 120, 3600e3)) throw new HttpError(429, 'Too many searches. Wait a bit and try again.');
    const results = [];
    for (const o of Object.values(state.users)) {
      if (o.id === user.id || !o.searchable || o.archived) continue;
      const names = nameWords(`${o.givenName} ${o.familyName} ${o.name}`);
      if (!words.every((w) => names.some((n) => n.startsWith(w)))) continue;
      const mine = user.friends.includes(o.id), theirs = o.friends.includes(user.id);
      results.push({ ...publicCard(o), status: mine && theirs ? 'friends' : mine ? 'requested' : theirs ? 'incoming' : null });
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    return { results: results.slice(0, 20), more: results.length > 20 };
  });
  // Send a request by friend code, or by id for someone found in name search.
  route('POST', '/api/friends/request', { auth: 'user' }, ({ user, body }) => {
    if (!limiter.hit(`freq:${user.id}`, 30, 3600e3)) throw new HttpError(429, 'Too many requests. Wait a bit and try again.');
    let other;
    if (body.id !== undefined) {
      other = getUser(body.id);
      if (!other || other.archived || !(other.searchable || other.friends.includes(user.id) || suggestReason(user, other))) throw new HttpError(404, 'That person can\'t be found');
      if (other.id === user.id) throw bad("That's you");
    } else {
      other = findByCode(body.code);
      if (!other) throw new HttpError(404, 'No one has that code');
      if (other.id === user.id) throw bad("That's your own code");
    }
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
  // People you may know: friends of your friends, and people in your classes. Each person chooses
  // (Profile → Privacy) whether they're suggested through mutual friends and through classes; classes
  // count only when that person shares their schedule, and the reason never says which class.
  function suggestReason(user, o, myFriends = new Set(confirmedFriends(user))) {
    if (o.id === user.id || o.archived) return null;
    const mutual = o.suggest.viaFriends ? confirmedFriends(o).filter((id) => myFriends.has(id)).length : 0;
    const shared = o.suggest.viaClasses && o.shareSchedule ? bell.BLOCK_KEYS.filter((k) => sameClass(user.classes[k], o.classes[k])).length : 0;
    return mutual || shared ? { mutual, sharedClasses: shared } : null;
  }
  route('GET', '/api/friends/suggestions', { auth: 'user' }, ({ user }) => {
    if (!user.suggest.show) return { suggestions: [], off: true };
    const myFriends = new Set(confirmedFriends(user));
    const out = [];
    for (const o of Object.values(state.users)) {
      if (user.friends.includes(o.id) || o.friends.includes(user.id) || user.hiddenSuggestions.includes(o.id)) continue;
      const why = suggestReason(user, o, myFriends);
      if (why) out.push({ ...publicCard(o), ...why, score: why.mutual * 3 + why.sharedClasses * 2 });
    }
    out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return { suggestions: out.slice(0, 8).map(({ score, ...s }) => s) };
  });
  route('POST', '/api/friends/suggestions/:id/hide', { auth: 'user' }, ({ user, params }) => {
    if (!getUser(params.id)) throw new HttpError(404, 'That person can\'t be found');
    if (!user.hiddenSuggestions.includes(params.id)) {
      user.hiddenSuggestions.push(params.id);
      if (user.hiddenSuggestions.length > MAX_HIDDEN_SUGGESTIONS) user.hiddenSuggestions.shift();
      db.save();
    }
    return { ok: true };
  });
  route('DELETE', '/api/friends/suggestions/hidden', { auth: 'user' }, ({ user }) => {
    user.hiddenSuggestions = [];
    db.save();
    return profile(user);
  });

  // What one friend may see of your schedule.
  route('PUT', '/api/friends/:id', { auth: 'user' }, ({ user, params, body }) => {
    if (!user.friends.includes(params.id)) throw new HttpError(404, 'Not on your friend list');
    if (!SHARE_LEVELS.includes(body.level)) throw bad('Invalid setting');
    if (body.level === user.shareDefault) delete user.shareLevels[params.id];
    else user.shareLevels[params.id] = body.level;
    db.save();
    return { ok: true, level: body.level };
  });
  // Unfriend, decline a request, or cancel one you sent.
  route('DELETE', '/api/friends/:id', { auth: 'user' }, ({ user, params }) => {
    const other = getUser(params.id);
    user.friends = user.friends.filter((f) => f !== params.id);
    if (hasOwn(user.shareLevels, params.id)) delete user.shareLevels[params.id];
    if (other) { other.friends = other.friends.filter((f) => f !== user.id); delete other.shareLevels[user.id]; }
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
    ...Object.assign({}, ...features.map((f) => f.status())),
    lastSnapshot: db.lastSnapshot(),
    graduation: isPlainObject(state.school) ? state.school.graduation : null,
    seniors: Object.values(state.users).filter((u) => u.grade === 12 && !u.archived && !isAdmin(u)).length,
    archived: Object.values(state.users).filter((u) => u.archived).length,
    tz: config.tz,
    today: today(),
    secureCookies: config.secure
  }));
  route('GET', '/api/admin/users', { auth: 'admin' }, () => Object.values(state.users)
    .map((u) => ({
      id: u.id, name: u.name, email: u.email, created: u.created, lastLogin: u.lastLogin, admin: isAdmin(u),
      verified: u.verified === true, friends: u.friends.length, fullName: `${u.givenName} ${u.familyName}`.trim(),
      grade: u.grade, bio: u.bio, profileLocked: u.profileLocked, searchable: u.searchable,
      owner: isOwner(u), pronouns: u.pronouns, interests: u.interests, avatar: u.avatar, photo: photoUrl(u),
      pendingPhoto: isPlainObject(u.photo) && u.photo.pending ? `/photos/${u.photo.pending}.jpg` : null,
      archived: u.archived ? { at: u.archived.at, deleteAfter: u.archived.deleteAfter } : null
    }))
    .sort((a, b) => b.lastLogin - a.lastLogin));
  // Admins can verify people, edit or reset anyone's profile, and lock a profile against changes.
  route('PUT', '/api/admin/users/:id', { auth: 'admin' }, ({ user, params, body }) => {
    const target = getUser(params.id);
    if (!target) throw new HttpError(404, 'No such user');
    for (const k of ['verified', 'profileLocked', 'admin']) if (body[k] !== undefined && typeof body[k] !== 'boolean') throw bad('Invalid setting');
    if (body.archived !== undefined) { // only un-archiving: someone archived at graduation by mistake
      if (body.archived !== false) throw bad('Invalid setting');
      delete target.archived;
      log(`User ${target.id} un-archived by admin ${user.id}`);
      db.save();
      return { ok: true };
    }
    if (body.reset !== undefined && body.reset !== true) throw bad('Invalid setting');
    if (body.admin !== undefined) {
      if (isOwner(target)) throw bad('This person is an owner (in ADMIN_EMAILS); change that setting to remove them');
      if (target.id === user.id) throw bad("You can't change your own admin role");
    }
    const fields = body.reset ? resetFields(target) : cleanProfileFields(body);
    const changed = [...Object.keys(fields), ...['verified', 'profileLocked', 'admin'].filter((k) => body[k] !== undefined)];
    if (!changed.length) throw bad('Nothing to change');
    Object.assign(target, fields);
    if (body.reset) photosFeature.clear(target); // a reset removes their photo too
    if (body.verified !== undefined) target.verified = body.verified;
    if (body.profileLocked !== undefined) target.profileLocked = body.profileLocked;
    if (body.admin !== undefined) target.adminGranted = body.admin;
    log(`User ${target.id} ${body.reset ? 'profile reset' : `changed (${changed.join(', ')})`} by admin ${user.id}`);
    db.save();
    return {
      ok: true, verified: target.verified === true, name: target.name, grade: target.grade, bio: target.bio, profileLocked: target.profileLocked,
      pronouns: target.pronouns, interests: target.interests, avatar: target.avatar, admin: isAdmin(target)
    };
  });
  route('DELETE', '/api/admin/users/:id', { auth: 'admin' }, ({ user, params }) => {
    const target = getUser(params.id);
    if (!target) throw new HttpError(404, 'No such user');
    if (target.id === user.id) throw bad('Use the Account page to delete your own account');
    if (isOwner(target) && !isOwner(user)) throw new HttpError(403, 'Only an owner can remove an owner');
    log(`User ${target.id} removed by admin ${user.id}`);
    deleteUser(target.id);
    return { ok: true };
  });
  // The whole links list at once, in the order given.
  route('PUT', '/api/admin/links', { auth: 'admin' }, ({ user, body }) => {
    if (!Array.isArray(body.links) || body.links.length > MAX_LINKS) throw bad(`Send up to ${MAX_LINKS} links`);
    const links = body.links.map(cleanLink);
    const badAt = links.findIndex((l) => !l);
    if (badAt >= 0) throw bad(`Link ${badAt + 1} needs a title and a web address starting with https://`);
    state.links = links;
    log(`Links updated by admin ${user.id} (${links.length})`);
    db.save();
    return state.links;
  });
  route('PUT', '/api/admin/calendar', { auth: 'admin' }, ({ body }) => {
    state.calendar = cal.cleanCalendar(body, today());
    db.save();
    return state.calendar;
  });
  route('GET', '/api/admin/backup', { auth: 'admin' }, ({ req, res, user }) => {
    audit('backup downloaded', req, user);
    const body = JSON.stringify(exportData());
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="mhs-today-backup-${new Date().toISOString().slice(0, 10)}.json"`
    });
    res.end(body);
  });
  // The audit log (owners only): newest first, 100 at a time, with a search; or the whole file.
  route('GET', '/api/admin/audit', { auth: 'admin' }, ({ user, url }) => {
    if (!isOwner(user)) throw new HttpError(403, 'Only owners can see the audit log');
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null;
    return auditLog.page({ before, limit: 100, q: (url.searchParams.get('q') || '').slice(0, 100) });
  });
  route('GET', '/api/admin/audit/download', { auth: 'admin' }, ({ req, res, user, url }) => {
    if (!isOwner(user)) throw new HttpError(403, 'Only owners can download the audit log');
    audit('audit log downloaded', req, user);
    return auditLog.download(res, url.searchParams.get('format') === 'csv' ? 'csv' : 'jsonl');
  });
  route('POST', '/api/admin/restore', { auth: 'admin', maxBody: 12 * MB, auditBody: false }, ({ user, body }) => {
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
    if (r.auth === 'admin' && !isAdmin(user)) {
      if (method !== 'GET') audit('refused (not an admin)', req, user, { target: `${method} ${url.pathname}` });
      throw new HttpError(403, 'Admins only');
    }
    if (method !== 'GET' && user && !limiter.hit(`write:${user.id}`, 120, 60e3)) throw new HttpError(429, 'Slow down a little');
    if (method !== 'GET' && user && !agreedNow(user) && !['POST /api/me/agree', 'POST /api/logout', 'DELETE /api/me'].includes(`${method} ${r.pattern}`)) {
      throw Object.assign(new HttpError(403, 'Please read and agree to the Privacy & Terms first'), { mustAgree: true });
    }
    const params = {};
    try { r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); }); } catch { throw bad('Bad request'); }
    const body = method === 'POST' || method === 'PUT' ? await readJson(req, r.maxBody || 100 * 1024) : {};
    const result = await r.handler({ req, res, url, params, user, body });
    if (method !== 'GET' && r.audit) {
      audit(`${method} ${r.pattern}`, req, user, { target: Object.keys(params).length ? params : null, detail: r.auditBody ? auditDetail(body) : null });
    }
    if (!res.writableEnded) sendJson(res, 200, result);
  }

  // ---------- Google sign-in ----------
  function authStart(req, res, url) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (!google) return redirect(res, '/login.html?error=config');
    if (!limiter.hit(`auth:${clientIp(req)}`, 300, 60e3)) return redirect(res, '/login.html?error=busy');
    // ?connect=tasks: a signed-in person allowing access to their Google Tasks (same round trip).
    const forTasks = url.searchParams.get('connect') === 'tasks';
    const me = forTasks ? currentUser(req) : null;
    if (forTasks && !tasks.enabled) return redirect(res, '/classwork.html');
    if (forTasks && !me) return redirect(res, '/login.html?next=classwork.html');
    const pkce = newPkce();
    const pending = {
      s: crypto.randomBytes(16).toString('base64url'), n: crypto.randomBytes(16).toString('base64url'),
      v: pkce.verifier, next: forTasks ? '/classwork.html' : safeNext(url.searchParams.get('next')), exp: Date.now() + 10 * 60e3,
      ...(forTasks ? { purpose: 'tasks', uid: me.id } : {})
    };
    addCookie(res, serializeCookie(PENDING, sign(pending), { maxAge: 600, secure: config.secure }));
    redirect(res, google.authUrl({
      state: pending.s, nonce: pending.n, challenge: pkce.challenge,
      ...(forTasks ? { scope: tasks.REQUEST_SCOPE, offline: true, loginHint: me.email } : {})
    }));
  }

  async function authCallback(req, res, url) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (!google) return redirect(res, '/login.html?error=config');
    const pending = unsign(parseCookies(req.headers.cookie)[PENDING]);
    const forTasks = !!pending && pending.purpose === 'tasks';
    const fail = (code) => {
      clearCookie(res, PENDING);
      return redirect(res, forTasks ? `/classwork.html?tasks=${code}` : `/login.html?error=${code}`);
    };
    if (!limiter.hit(`auth:${clientIp(req)}`, 300, 60e3)) return fail('busy');

    const q = url.searchParams;
    if (q.get('error')) return fail(q.get('error') === 'access_denied' ? 'denied' : 'failed');
    const code = q.get('code');
    // The cookie ties this callback to the browser that started the sign-in (stops login CSRF).
    if (!pending || !safeEqual(q.get('state') || '', pending.s)) return fail('state');
    if (!code || code.length > 2048) return fail('failed');
    if (forTasks) return connectTasks(req, res, pending, code, fail);
    try {
      const claims = await google.verifyIdToken(await google.exchangeCode(code, pending.v), pending.n);
      if (!google.domainAllowed(claims)) {
        log(`Sign-in blocked: Google Workspace domain "${claims.hd || '(none: personal account)'}" is not in ALLOWED_DOMAINS (${config.allowedDomains.join(', ')})`);
        audit('sign-in refused (domain)', req, null, { detail: { email: claims.email, domain: claims.hd || null } });
        return fail('domain');
      }
      const { user, isNew } = upsertUser(claims);
      createSession(req, res, user);
      clearCookie(res, PENDING);
      log(`Signed in: user ${user.id}${isNew ? ' (new account)' : ''}`);
      audit(isNew ? 'sign-in (new account)' : 'sign-in', req, user);
      return redirect(res, pending.next);
    } catch (e) {
      if (!(e instanceof AuthError)) log('Sign-in error:', e && e.stack || e);
      else log(`Sign-in failed: ${e.message}`);
      return fail(e instanceof AuthError ? e.code : 'failed');
    }
  }

  // The second half of "connect Google Tasks": only for the person who started it, and only for
  // their own Google account (the one they sign in with).
  async function connectTasks(req, res, pending, code, fail) {
    const user = currentUser(req);
    if (!user || user.id !== pending.uid) return fail('signin');
    let body;
    try {
      body = await google.exchangeTokens(code, pending.v);
      const claims = await google.verifyIdToken(body.id_token, pending.n);
      if (claims.sub !== user.sub) {
        if (body.refresh_token) google.revoke(body.refresh_token);
        return fail('account');
      }
      tasks.connect(user, body);
    } catch (e) {
      if (e instanceof tasks.ConnectError) {
        if (body && body.refresh_token) google.revoke(body.refresh_token);
        return fail(e.code);
      }
      log(`Connecting Google Tasks failed: ${e.message}`);
      return fail('failed');
    }
    clearCookie(res, PENDING);
    return redirect(res, '/classwork.html?tasks=connected');
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
      if (url.pathname.startsWith('/cal/')) return calendarFeed.feed(req, res, url);
      if (url.pathname.startsWith('/photos/')) return photosFeature.serve(req, res, url, currentUser(req));
      if (url.pathname === '/tools' || url.pathname === '/tools.html') return redirect(res, '/links.html#tools'); // tools are a section of Links
      return await serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 413) res.setHeader('Connection', 'close'); // don't wait for the rest of the upload
        return sendJson(res, e.status, { error: e.message, ...(e.mustAgree ? { mustAgree: true } : {}) });
      }
      log('Unhandled error:', (e && e.stack) || e);
      if (!res.headersSent) return sendJson(res, 500, { error: 'Something went wrong on the server' });
      res.end();
    }
  }

  // ---------- lifecycle ----------
  // Graduation: on the day an admin set, seniors' accounts (grade 12, not admins) are archived (they
  // can't sign in and disappear from search and friends lists) and everyone else moves up a grade.
  // Archived accounts are deleted ARCHIVE_DAYS later, unless an admin restores one.
  const ARCHIVE_DAYS = 90;
  function graduate(now) {
    if (!isPlainObject(state.school)) state.school = { graduation: null, graduated: null };
    const day = state.school.graduation;
    if (day && today() >= day && state.school.graduated !== day) {
      let archived = 0, movedUp = 0;
      for (const u of Object.values(state.users)) {
        if (u.archived) continue;
        if (u.grade === 12 && !isAdmin(u)) {
          u.archived = { at: now, deleteAfter: now + ARCHIVE_DAYS * 86400e3 };
          for (const [h, s] of Object.entries(state.sessions)) if (s.userId === u.id) delete state.sessions[h];
          archived++;
        } else if (GRADES.includes(u.grade) && u.grade < 12) { u.grade += 1; movedUp++; }
      }
      state.school.graduated = day;
      log(`Graduation (${day}): ${archived} senior accounts archived, ${movedUp} students moved up a grade`);
      auditLog.record('graduation', { detail: { date: day, archived, movedUp } });
    }
    for (const u of Object.values(state.users)) {
      if (u.archived && u.archived.deleteAfter < now) {
        auditLog.record('archived account deleted', { target: { id: u.id, name: u.name, email: u.email } });
        deleteUser(u.id);
      }
    }
  }
  route('PUT', '/api/admin/school', { auth: 'admin' }, ({ body }) => {
    const day = body.graduation;
    if (day !== null && (typeof day !== 'string' || cal.parseDate(day) === null)) throw bad('Pick a valid date');
    if (day && (day < cal.addDays(today(), -7) || day > cal.addDays(today(), 400))) throw bad('Pick a date in the next year');
    state.school = { ...(isPlainObject(state.school) ? state.school : {}), graduation: day };
    db.save();
    return state.school;
  });

  function maintain() {
    const now = Date.now();
    for (const [h, s] of Object.entries(state.sessions)) if (s.expires < now) delete state.sessions[h];
    graduate(now);
    for (const f of features) f.maintain();
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
  let reminderTimer = null;
  const runReminders = () => push.runReminders().catch((e) => log(`Reminders failed: ${e.message}`));

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        maintain();
        timer = setInterval(maintain, 6 * 3600e3);
        timer.unref();
        reminderTimer = setInterval(runReminders, 5 * 60e3);
        reminderTimer.unref();
        resolve(server.address().port);
      });
    });
  }
  function close() {
    return new Promise((resolve) => {
      if (timer) clearInterval(timer);
      if (reminderTimer) clearInterval(reminderTimer);
      const force = setTimeout(() => server.closeAllConnections(), 3000);
      force.unref();
      server.close(() => { clearTimeout(force); db.close(); auditLog.close(); resolve(); }); // also fires if it was never listening
      server.closeIdleConnections();
    });
  }

  return { server, listen, close, config, state, db, google: !!google, runReminders: () => push.runReminders(), runMaintenance: maintain };
}

module.exports = { createApp };
