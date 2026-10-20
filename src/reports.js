'use strict';
// Reports: anyone signed in can report something someone else posted (an event, a group post,
// reply or poll, a study session, a class event, a profile). Reports on the same thing go
// together; three different people hide it (its author and admins still see it, marked hidden)
// until an admin keeps it or removes it in Admin → Review. Profiles are never hidden by reports;
// an admin can reset them instead.
//
// Each kind of content registers a handler:
//   locate(ref, user) -> { id, ref, author, summary, link } | null   (null when `user` can't see it)
//   remove(ref)       -> deletes it (or, for profiles, resets it)
//   exists(ref)       -> is it still there?
//   hide              -> false for kinds that reports never hide
const HIDE_AT = 3;
const MAX_REPORTS = 5000;
const REASONS = ['mean', 'inappropriate', 'spam', 'private', 'other'];
const KEEP_RESOLVED_DAYS = 365;

module.exports = function reports(app) {
  const { route, state, db, log, HttpError, bad, getUser, isAdmin, cleanText, randomId, limiter, publicCard, isPlainObject } = app;
  if (!Array.isArray(state.reports)) state.reports = [];
  const kinds = {};
  const keyOf = (kind, id) => `${kind}:${id}`;
  const openFor = (key) => state.reports.find((r) => r.key === key && !r.resolved) || null;

  const api = {
    REASONS,
    register(kind, handler) { kinds[kind] = handler; },
    // hidden by reports, and not kept by an admin yet
    hidden(kind, id) { const r = openFor(keyOf(kind, id)); return !!r && r.hidden; },
    // may `user` see it? Everyone, unless it's hidden: then only its author and admins.
    visible(kind, id, authorId, user) { return !api.hidden(kind, id) || (!!user && (user.id === authorId || isAdmin(user))); },
    openCount: () => state.reports.filter((r) => !r.resolved).length
  };

  route('POST', '/api/reports', { auth: 'user' }, ({ user, body }) => {
    const h = hasKind(body.kind) ? kinds[body.kind] : null;
    if (!h) throw bad('That can\'t be reported');
    const found = h.locate(isPlainObject(body.ref) ? body.ref : {}, user);
    if (!found) throw new HttpError(404, 'Not found');
    if (found.author === user.id) throw bad('That\'s yours: you can delete it instead');
    const key = keyOf(body.kind, found.id);
    let r = openFor(key);
    if (r && r.reports.some((x) => x.by === user.id)) return { ok: true, hidden: r.hidden, already: true };
    if (!isAdmin(user) && !limiter.hit(`report:${user.id}`, 20, 86400e3)) throw new HttpError(429, 'You can report up to 20 things a day');
    if (!r) {
      if (state.reports.length >= MAX_REPORTS) state.reports = state.reports.filter((x) => !x.resolved);
      if (state.reports.length >= MAX_REPORTS) throw bad('Too many reports are waiting. Try again later.');
      r = { id: randomId(), key, kind: body.kind, ref: found.ref, author: found.author, summary: '', link: '', reports: [], hidden: false, created: Date.now(), resolved: null };
      state.reports.push(r);
    }
    r.summary = found.summary;
    r.link = found.link;
    r.reports.push({ by: user.id, reason: REASONS.includes(body.reason) ? body.reason : 'other', note: cleanText(body.note, 300), at: Date.now() });
    if (!r.hidden && h.hide !== false && r.reports.length >= HIDE_AT) r.hidden = true;
    db.save();
    return { ok: true, hidden: r.hidden };
  });
  function hasKind(k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(kinds, k); }

  // ---- admins: the review queue
  const view = (r) => {
    const a = r.author ? getUser(r.author) : null;
    return {
      id: r.id, kind: r.kind, summary: r.summary, link: r.link, hidden: r.hidden, created: r.created, resolved: r.resolved,
      author: a ? { ...publicCard(a), email: a.email } : null,
      reports: r.reports.map((x) => { const u = getUser(x.by); return { reason: x.reason, note: x.note, at: x.at, by: u ? u.name : 'Former student' }; })
    };
  };
  route('GET', '/api/admin/reports', { auth: 'admin' }, () => {
    const open = state.reports.filter((r) => !r.resolved).sort((a, b) => b.reports.length - a.reports.length || a.created - b.created);
    const done = state.reports.filter((r) => r.resolved).sort((a, b) => b.resolved.at - a.resolved.at).slice(0, 30);
    return { open: open.map(view), done: done.map(view) };
  });
  function resolve(id, user, action) {
    const r = state.reports.find((x) => x.id === id && !x.resolved);
    if (!r) throw new HttpError(404, 'That report was already handled');
    if (action === 'removed') {
      const h = kinds[r.kind];
      if (h && h.exists(r.ref)) h.remove(r.ref);
    }
    r.hidden = false;
    r.resolved = { by: user.id, action, at: Date.now() };
    log(`Report ${r.id} (${r.kind}) ${action} by admin ${user.id}`);
    db.save();
    return { ok: true };
  }
  route('POST', '/api/admin/reports/:id/keep', { auth: 'admin' }, ({ user, params }) => resolve(params.id, user, 'kept'));
  route('POST', '/api/admin/reports/:id/remove', { auth: 'admin' }, ({ user, params }) => resolve(params.id, user, 'removed'));

  return Object.assign(api, {
    status: () => ({ reportsOpen: api.openCount() }),
    exportData: () => ({}), // reports are short-lived; a restore starts with an empty queue
    importData() { state.reports = []; return {}; },
    maintain() {
      const cutoff = Date.now() - KEEP_RESOLVED_DAYS * 86400e3;
      state.reports = state.reports.filter((r) => (r.resolved ? r.resolved.at >= cutoff : !kinds[r.kind] || kinds[r.kind].exists(r.ref)));
    },
    forgetUser(id) {
      state.reports = state.reports.filter((r) => r.author !== id);
      for (const r of state.reports) r.reports = r.reports.filter((x) => x.by !== id);
      state.reports = state.reports.filter((r) => r.resolved || r.reports.length);
    }
  });
};
