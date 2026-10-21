'use strict';
// Site visitors for the admin page: how many people (not bots) opened a page each day, how many of
// them were signed in, and how many pages they opened. Nothing about who: a visitor is a salted hash
// of their network address and browser, the salt changes every day, and only the day's totals are
// kept (400 days) in $DATA_DIR/visits.json. Written at most once a minute, not with every page.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEEP_DAYS = 400;
const MAX_SEEN = 50000; // a day's distinct visitors we remember (far more than the school has)
// Crawlers, link previews, monitors and scripts. Real browsers say "Mozilla/" and send a language.
const BOT = /bot\b|bot\/|crawl|spider|slurp|archiver|facebookexternalhit|embedly|preview|whatsapp|telegram|discord|slack|skype|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|undici|headless|phantom|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|statuscake|scanner|httpclient|libwww|postman|insomnia/i;

function isHuman(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (req.method !== 'GET' || !/^Mozilla\//.test(ua) || BOT.test(ua) || !req.headers['accept-language']) return false;
  const purpose = String(req.headers['sec-purpose'] || req.headers.purpose || '');
  return !/prefetch|prerender/i.test(purpose); // the browser guessing a link, not someone opening it
}

function openVisits(dataDir, { today, log = () => {} }) {
  const file = path.join(dataDir, 'visits.json');
  let data = { day: null, salt: '', seen: [], users: [], days: {} };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && typeof d === 'object' && d.days && typeof d.days === 'object') data = { ...data, ...d };
  } catch { /* no file yet, or damaged: start counting again */ }
  let seen = new Set(Array.isArray(data.seen) ? data.seen : []);
  let users = new Set(Array.isArray(data.users) ? data.users : []);
  let dirty = false, timer = null;

  function rollover() {
    const d = today();
    if (data.day === d) return;
    data.day = d;
    data.salt = crypto.randomBytes(16).toString('hex');
    seen = new Set(); users = new Set();
    const oldest = Object.keys(data.days).sort().slice(0, Math.max(0, Object.keys(data.days).length - KEEP_DAYS + 1));
    for (const k of oldest) delete data.days[k];
  }
  const hash = (s) => crypto.createHash('sha256').update(data.salt + s).digest('base64url').slice(0, 16);

  // A page was opened. `ip` and the browser make a visitor; `userId` (if signed in) is counted once too.
  function hit(req, ip, userId) {
    if (!isHuman(req)) return;
    rollover();
    const day = data.days[data.day] || (data.days[data.day] = { visitors: 0, signedIn: 0, views: 0 });
    day.views++;
    const v = hash(`${ip}|${req.headers['user-agent']}`);
    if (!seen.has(v) && seen.size < MAX_SEEN) { seen.add(v); day.visitors++; }
    if (userId) {
      const u = hash(`u:${userId}`);
      if (!users.has(u) && users.size < MAX_SEEN) { users.add(u); day.signedIn++; }
    }
    dirty = true;
    if (!timer) { timer = setTimeout(flush, 60e3); timer.unref(); }
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ...data, seen: [...seen], users: [...users] }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (e) { log(`Could not save visit counts: ${e.message}`); }
  }
  // The last `n` days, oldest first, with zeros for days nobody came.
  function recent(n, addDays) {
    rollover();
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = addDays(data.day, -i);
      out.push({ date: d, ...(data.days[d] || { visitors: 0, signedIn: 0, views: 0 }) });
    }
    return out;
  }
  return { hit, flush, recent, close: flush };
}

module.exports = { openVisits, isHuman };
