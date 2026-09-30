'use strict';
const crypto = require('node:crypto');

// ---- text -----------------------------------------------------------------
// Control characters, zero-width and bidi-override characters (they can be
// used to spoof names) are replaced with spaces; built from code points so the
// source stays plain ASCII.
const hex4 = (n) => '\\u' + n.toString(16).padStart(4, '0');
const UNWANTED = new RegExp(
  '[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
    .map(([a, b]) => hex4(a) + '-' + hex4(b)).join('') + ']', 'g');

// One line of trimmed text, at most `max` characters (code points, not bytes).
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(UNWANTED, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trim() : s;
}

// ---- ids, hashes, comparisons -------------------------------------------
const randomId = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Friend codes: 10 characters, no look-alikes (0/O, 1/I/L). ~49 bits.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newFriendCode() {
  let s = '';
  for (let i = 0; i < 10; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
// Accepts 'abcde-fghjk', ' ABCDE FGHJK ' etc. Returns the canonical code or null.
function normalizeFriendCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  return new RegExp('^[' + CODE_ALPHABET + ']{10}$').test(s) ? s : null;
}

// ---- cookies ----------------------------------------------------------------
function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch { continue; } // ignore malformed cookies instead of failing the request
    if (!(name in out)) out[name] = value;
  }
  return out;
}
function serializeCookie(name, value, { maxAge, secure } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) s += `; Max-Age=${Math.floor(maxAge)}`;
  if (secure) s += '; Secure';
  return s;
}

// ---- rate limiting ----------------------------------------------------------
class RateLimiter {
  constructor() { this.buckets = new Map(); this.lastPrune = Date.now(); }
  // Returns true while `key` is within `limit` hits per `windowMs`.
  hit(key, limit, windowMs, now = Date.now()) {
    if (now - this.lastPrune > 60000 || this.buckets.size > 100000) this.prune(now);
    let b = this.buckets.get(key);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; this.buckets.set(key, b); }
    b.count++;
    return b.count <= limit;
  }
  prune(now = Date.now()) {
    this.lastPrune = now;
    for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k);
    if (this.buckets.size > 100000) this.buckets.clear(); // pathological: start over rather than grow forever
  }
}

module.exports = { cleanText, randomId, sha256hex, safeEqual, hasOwn, newFriendCode, normalizeFriendCode, parseCookies, serializeCookie, RateLimiter };
