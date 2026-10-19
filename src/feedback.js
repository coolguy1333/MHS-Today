'use strict';
// Feedback, handled in the app: anyone signed in sends a bug, idea or question; admins see them in
// the Admin page's Feedback tab, mark them seen or done, and reply. The person sees the reply on
// their Feedback page (and gets a notification if they have them on).
const TYPES = ['bug', 'idea', 'question', 'other'];
const STATUSES = ['new', 'seen', 'done'];
const MAX_FEEDBACK = 5000;
const MAX_REPLIES = 20;
const KEEP_DONE_DAYS = 365; // finished feedback is removed a year after it was last touched

module.exports = function feedback(app) {
  const { route, state, db, HttpError, bad, getUser, cleanText, randomId, limiter, isPlainObject, hasOwn, num, publicCard, notify } = app;
  if (!Array.isArray(state.feedback)) state.feedback = [];

  const find = (id) => state.feedback.find((f) => f.id === id) || null;
  const cleanMessage = (s, n) => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, n) : '');
  const replyView = (r) => { const a = getUser(r.by); return { text: r.text, at: r.at, by: a ? a.name : 'An admin' }; };
  const mineView = (f) => ({ id: f.id, type: f.type, message: f.message, created: f.created, status: f.status, replies: f.replies.map(replyView), unread: !!f.unread });

  route('POST', '/api/feedback', { auth: 'user' }, ({ user, body }) => {
    const type = TYPES.includes(body.type) ? body.type : null;
    if (!type) throw bad('Pick bug, idea, question or other');
    const message = cleanMessage(body.message, 2000);
    if (message.length < 3) throw bad('Write a little more');
    if (state.feedback.length >= MAX_FEEDBACK) throw bad('The feedback inbox is full. Try again later.');
    if (!limiter.hit(`feedback:${user.id}`, 10, 86400e3)) throw new HttpError(429, 'You can send up to 10 messages a day');
    const page = typeof body.page === 'string' && /^\/[\w./?=&#-]{0,200}$/.test(body.page) ? body.page : '';
    const f = { id: randomId(), by: user.id, type, message, page, created: Date.now(), updated: Date.now(), status: 'new', replies: [], unread: false };
    state.feedback.push(f);
    db.save();
    return mineView(f);
  });
  // Your own feedback, newest first. Looking at it marks the replies read.
  route('GET', '/api/feedback', { auth: 'user' }, ({ user }) => {
    const mine = state.feedback.filter((f) => f.by === user.id).sort((a, b) => b.created - a.created);
    const out = mine.map(mineView);
    if (mine.some((f) => f.unread)) { for (const f of mine) f.unread = false; db.save(); }
    return out;
  });

  // ---- admins
  route('GET', '/api/admin/feedback', { auth: 'admin' }, () => state.feedback.slice().sort((a, b) => b.created - a.created).map((f) => {
    const u = getUser(f.by);
    return {
      id: f.id, type: f.type, message: f.message, page: f.page, created: f.created, status: f.status, replies: f.replies.map(replyView),
      from: u ? { ...publicCard(u), email: u.email } : null
    };
  }));
  route('PUT', '/api/admin/feedback/:id', { auth: 'admin' }, ({ params, body }) => {
    const f = find(params.id);
    if (!f) throw new HttpError(404, 'Not found');
    if (!STATUSES.includes(body.status)) throw bad('Pick new, seen or done');
    f.status = body.status;
    f.updated = Date.now();
    db.save();
    return { ok: true };
  });
  route('POST', '/api/admin/feedback/:id/reply', { auth: 'admin' }, ({ user, params, body }) => {
    const f = find(params.id);
    if (!f) throw new HttpError(404, 'Not found');
    const text = cleanMessage(body.text, 2000);
    if (!text) throw bad('Write a reply');
    if (f.replies.length >= MAX_REPLIES) throw bad('This conversation is long enough. Mark it done.');
    f.replies.push({ by: user.id, text, at: Date.now() });
    f.unread = true;
    if (f.status === 'new') f.status = 'seen';
    f.updated = Date.now();
    db.save();
    notify([f.by], null, { title: 'MHS Today answered your feedback', body: text.slice(0, 140), url: '/feedback.html' });
    return { ok: true };
  });
  route('DELETE', '/api/admin/feedback/:id', { auth: 'admin' }, ({ params }) => {
    const i = state.feedback.findIndex((f) => f.id === params.id);
    if (i < 0) throw new HttpError(404, 'Not found');
    state.feedback.splice(i, 1);
    db.save();
    return { ok: true };
  });

  return {
    unreadFor: (user) => state.feedback.filter((f) => f.by === user.id && f.unread).length,
    newCount: () => state.feedback.filter((f) => f.status === 'new').length,
    userData: (user) => ({ feedback: state.feedback.filter((f) => f.by === user.id).map(mineView) }),
    status: () => ({ feedbackNew: state.feedback.filter((f) => f.status === 'new').length }),
    exportData: () => ({ feedback: state.feedback }),
    importData(data, users) {
      const out = [];
      for (const f of Array.isArray(data.feedback) ? data.feedback.slice(0, MAX_FEEDBACK) : []) {
        if (!isPlainObject(f) || typeof f.id !== 'string' || !/^[0-9a-f]{16}$/.test(f.id) || !hasOwn(users, f.by) || out.some((x) => x.id === f.id)) continue;
        const message = cleanMessage(f.message, 2000);
        if (!message || !TYPES.includes(f.type)) continue;
        out.push({
          id: f.id, by: f.by, type: f.type, message, page: typeof f.page === 'string' && /^\/[\w./?=&#-]{0,200}$/.test(f.page) ? f.page : '',
          created: num(f.created), updated: num(f.updated) || num(f.created), status: STATUSES.includes(f.status) ? f.status : 'new',
          replies: (Array.isArray(f.replies) ? f.replies : []).filter((r) => isPlainObject(r) && cleanMessage(r.text, 2000)).slice(0, MAX_REPLIES)
            .map((r) => ({ by: typeof r.by === 'string' ? r.by : '', text: cleanMessage(r.text, 2000), at: num(r.at) })),
          unread: f.unread === true
        });
      }
      state.feedback = out;
      return {};
    },
    maintain() {
      const cutoff = Date.now() - KEEP_DONE_DAYS * 86400e3;
      state.feedback = state.feedback.filter((f) => f.status !== 'done' || f.updated >= cutoff);
    },
    forgetUser(id) { state.feedback = state.feedback.filter((f) => f.by !== id); }
  };
};
