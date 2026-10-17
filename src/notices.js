'use strict';
// Site-wide notices set by admins: announcement banners (shown on every page between two dates),
// countdowns (shown on Today), and extra words for the word filter.
const MAX_ANNOUNCEMENTS = 20;
const MAX_COUNTDOWNS = 20;
const MAX_WORDS = 300;

module.exports = function notices(app) {
  const { route, state, db, log, bad, cleanText, randomId, today, cal, isPlainObject } = app;
  if (!Array.isArray(state.announcements)) state.announcements = [];
  if (!Array.isArray(state.countdowns)) state.countdowns = [];
  if (!Array.isArray(state.blockedWords)) state.blockedWords = [];

  const okDate = (d) => typeof d === 'string' && cal.parseDate(d) !== null;
  const keepId = (x) => (typeof x.id === 'string' && /^[0-9a-f]{16}$/.test(x.id) ? x.id : randomId());
  function cleanAnnouncement(a) {
    if (!isPlainObject(a)) return null;
    const text = cleanText(a.text, 200);
    if (!text || !okDate(a.start) || !okDate(a.end) || a.end < a.start) return null;
    return { id: keepId(a), text, start: a.start, end: a.end, urgent: a.urgent === true };
  }
  function cleanCountdown(c) {
    if (!isPlainObject(c)) return null;
    const title = cleanText(c.title, 60);
    return title && okDate(c.date) ? { id: keepId(c), title, date: c.date } : null;
  }
  const cleanWords = (list) => [...new Set(list.map((w) => cleanText(w, 40).toLowerCase()).filter(Boolean))].slice(0, MAX_WORDS);

  // What everyone sees today.
  route('GET', '/api/notices', { auth: 'none' }, () => {
    const t = today();
    return {
      announcements: state.announcements.filter((a) => a.start <= t && t <= a.end),
      countdowns: state.countdowns.filter((c) => c.date >= t).sort((a, b) => a.date.localeCompare(b.date))
    };
  });

  route('GET', '/api/admin/notices', { auth: 'admin' }, () => ({
    announcements: state.announcements, countdowns: state.countdowns, blockedWords: state.blockedWords
  }));
  route('PUT', '/api/admin/notices', { auth: 'admin' }, ({ user, body }) => {
    if (body.announcements !== undefined) {
      if (!Array.isArray(body.announcements) || body.announcements.length > MAX_ANNOUNCEMENTS) throw bad(`Up to ${MAX_ANNOUNCEMENTS} announcements`);
      const list = body.announcements.map(cleanAnnouncement);
      const at = list.findIndex((a) => !a);
      if (at >= 0) throw bad(`Announcement ${at + 1} needs text, a start date and an end date on or after it`);
      state.announcements = list;
    }
    if (body.countdowns !== undefined) {
      if (!Array.isArray(body.countdowns) || body.countdowns.length > MAX_COUNTDOWNS) throw bad(`Up to ${MAX_COUNTDOWNS} countdowns`);
      const list = body.countdowns.map(cleanCountdown);
      const at = list.findIndex((c) => !c);
      if (at >= 0) throw bad(`Countdown ${at + 1} needs a title and a date`);
      state.countdowns = list;
    }
    if (body.blockedWords !== undefined) {
      if (!Array.isArray(body.blockedWords) || body.blockedWords.length > MAX_WORDS) throw bad(`Up to ${MAX_WORDS} words`);
      state.blockedWords = cleanWords(body.blockedWords);
    }
    log(`Notices updated by admin ${user.id}`);
    db.save();
    return { announcements: state.announcements, countdowns: state.countdowns, blockedWords: state.blockedWords };
  });

  return {
    status: () => ({}),
    exportData: () => ({ announcements: state.announcements, countdowns: state.countdowns, blockedWords: state.blockedWords }),
    importData(data) {
      if (Array.isArray(data.announcements)) state.announcements = data.announcements.map(cleanAnnouncement).filter(Boolean).slice(0, MAX_ANNOUNCEMENTS);
      if (Array.isArray(data.countdowns)) state.countdowns = data.countdowns.map(cleanCountdown).filter(Boolean).slice(0, MAX_COUNTDOWNS);
      if (Array.isArray(data.blockedWords)) state.blockedWords = cleanWords(data.blockedWords);
    },
    // Old notices go away a month after they end.
    maintain() {
      const cutoff = cal.addDays(today(), -30);
      state.announcements = state.announcements.filter((a) => a.end >= cutoff);
      state.countdowns = state.countdowns.filter((c) => c.date >= cutoff);
    },
    forgetUser() {}
  };
};
