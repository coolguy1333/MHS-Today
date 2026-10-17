'use strict';
// Push notifications and reminders. People turn notifications on per device (on iPhone, the site
// has to be added to the home screen first) and choose which kinds they get:
//   classwork  the evening before something is due in one of their classes
//   events     an hour before an event they made, signed up for or were invited to, or a study session they're going to
//   groups     announcements in their groups
// The server's VAPID keys are made on first start and kept in db.json.
const webpush = require('./webpush');

const KINDS = ['classwork', 'events', 'groups'];
const MAX_SUBS = 5;
const EVENING = [18 * 60, 21 * 60]; // classwork reminders go out between 6 and 9 pm school time

module.exports = function push(app) {
  const { route, state, db, log, config, HttpError, bad, getUser, limiter, cal, bell, isPlainObject, fetchFn, features } = app;
  if (!isPlainObject(state.vapid) || typeof state.vapid.publicKey !== 'string' || typeof state.vapid.privateKey !== 'string') {
    state.vapid = webpush.generateVapidKeys();
    db.save();
  }
  if (!isPlainObject(state.sentReminders)) state.sentReminders = {};
  const subject = /^https:/.test(config.publicUrl) ? config.publicUrl : 'mailto:admin@mhs-hub.invalid';
  const prefsOf = (u) => ({ ...Object.fromEntries(KINDS.map((k) => [k, true])), ...(isPlainObject(u.notify) ? u.notify : {}) });
  const subsOf = (u) => (Array.isArray(u.pushSubs) ? u.pushSubs : []);

  // Sends to every device of each person who wants this kind. Never throws; dead subscriptions are dropped.
  async function notify(userIds, kind, msg) {
    const jobs = [];
    for (const id of new Set(userIds)) {
      const u = getUser(id);
      if (!u || !subsOf(u).length || (kind && !prefsOf(u)[kind])) continue;
      for (const sub of subsOf(u)) {
        jobs.push(webpush.send(sub, { title: msg.title, body: msg.body || '', url: msg.url || '/' }, { keys: state.vapid, subject, fetchFn: fetchFn || fetch })
          .then((status) => {
            if (status === 404 || status === 410) { u.pushSubs = subsOf(u).filter((s) => s.endpoint !== sub.endpoint); db.save(); }
            else if (status >= 400) log(`Push to ${new URL(sub.endpoint).hostname} failed with ${status}`);
          })
          .catch((e) => log(`Push failed: ${e.message}`)));
      }
    }
    await Promise.all(jobs);
  }

  route('GET', '/api/push', { auth: 'user' }, ({ user }) => ({ publicKey: state.vapid.publicKey, devices: subsOf(user).length, prefs: prefsOf(user) }));
  route('POST', '/api/push/subscribe', { auth: 'user' }, ({ user, body }) => {
    const keys = isPlainObject(body.keys) ? body.keys : {};
    if (typeof body.endpoint !== 'string' || !webpush.validEndpoint(body.endpoint)) throw bad('That browser\'s push service isn\'t supported');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh || '') || !/^[A-Za-z0-9_-]{16,32}$/.test(keys.auth || '')) throw bad('Invalid subscription');
    const subs = subsOf(user).filter((s) => s.endpoint !== body.endpoint);
    subs.push({ endpoint: body.endpoint, p256dh: keys.p256dh, auth: keys.auth, created: Date.now() });
    user.pushSubs = subs.slice(-MAX_SUBS);
    db.save();
    return { devices: user.pushSubs.length };
  });
  route('DELETE', '/api/push/subscribe', { auth: 'user' }, ({ user, url }) => {
    const endpoint = url.searchParams.get('endpoint');
    user.pushSubs = endpoint ? subsOf(user).filter((s) => s.endpoint !== endpoint) : [];
    db.save();
    return { devices: user.pushSubs.length };
  });
  route('PUT', '/api/push/prefs', { auth: 'user' }, ({ user, body }) => {
    const prefs = prefsOf(user);
    for (const k of KINDS) {
      if (body[k] === undefined) continue;
      if (typeof body[k] !== 'boolean') throw bad('Invalid setting');
      prefs[k] = body[k];
    }
    user.notify = prefs;
    db.save();
    return { prefs };
  });
  route('POST', '/api/push/test', { auth: 'user' }, async ({ user }) => {
    if (!subsOf(user).length) throw bad('Turn on notifications on this device first');
    if (!limiter.hit(`pushtest:${user.id}`, 5, 3600e3)) throw new HttpError(429, 'That\'s enough tests for now');
    await notify([user.id], null, { title: 'MHS Hub', body: 'Notifications are working 🎉', url: '/account.html' });
    return { ok: true };
  });

  // ---------- reminders (every few minutes) ----------
  const once = (key, days) => {
    if (state.sentReminders[key]) return false;
    state.sentReminders[key] = Date.now() + days * 86400e3;
    return true;
  };
  async function runReminders() {
    const now = cal.schoolNow(config.tz);
    const t = now.date;
    const classwork = features.find((f) => f.dueOn);
    const groups = features.find((f) => f.eventsForReminders);
    const jobs = [];
    let changed = false;

    // the evening before: everything due tomorrow in your classes, in one notification
    if (classwork && now.minutes >= EVENING[0] && now.minutes < EVENING[1]) {
      const due = classwork.dueOn(cal.addDays(t, 1));
      if (due.length) {
        for (const u of Object.values(state.users)) {
          if (!subsOf(u).length || !prefsOf(u).classwork) continue;
          const mine = due.filter((i) => classwork.inClass(u, i));
          if (!mine.length || !once(`cw:${t}:${u.id}`, 3)) continue;
          changed = true;
          const kind = { assignment: 'Assignment', quiz: 'Quiz', test: 'Test' };
          jobs.push(notify([u.id], 'classwork', {
            title: mine.length === 1 ? `${kind[mine[0].kind]} due tomorrow` : `${mine.length} things due tomorrow`,
            body: mine.map((i) => `${kind[i.kind]}: ${i.title} (${i.name})`).join('\n'), url: '/classwork.html'
          }));
        }
      }
    }
    // an hour before: events you made, signed up for or were invited to, and study sessions you're going to
    const soon = [
      ...(groups ? groups.eventsForReminders().map((e) => ({ key: `ev:${e.id}`, date: e.date, time: e.time, title: e.title, people: e.people, url: '/events.html' })) : []),
      ...(classwork ? classwork.studySessions().map((s) => ({ key: `st:${s.id}`, date: s.date, time: s.time, title: `Study session: ${s.title}`, people: s.going, url: '/classwork.html', where: s.place })) : [])
    ];
    for (const e of soon) {
      if (e.date !== t || !e.time) continue;
      const [hh, mm] = e.time.split(':').map(Number);
      const until = hh * 60 + mm - now.minutes;
      if (until <= 0 || until > 60 || !once(e.key, 2)) continue;
      changed = true;
      jobs.push(notify(e.people, 'events', {
        title: `Starting at ${bell.formatTime(e.time)}`, body: [e.title, e.where].filter(Boolean).join(' · '), url: e.url
      }));
    }
    if (changed) db.save();
    await Promise.all(jobs);
  }

  return {
    notify, runReminders,
    status: () => ({ pushDevices: Object.values(state.users).reduce((n, u) => n + subsOf(u).length, 0) }),
    exportData: () => ({}),
    importData() {},
    maintain() {
      const t = Date.now();
      for (const [k, exp] of Object.entries(state.sentReminders)) if (exp < t) delete state.sentReminders[k];
    },
    forgetUser() {}
  };
};
