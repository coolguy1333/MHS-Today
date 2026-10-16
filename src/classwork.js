'use strict';
// Classwork: classmates post assignments, quizzes and tests to a class. Only people who have that
// class (same name, and the same teacher when both are known) see them. Authors and admins can
// delete; three reports hide an item until an admin looks at it.
const KINDS = ['assignment', 'quiz', 'test'];
const KEEP_DAYS = 14;        // items are removed this long after they were due
const MAX_ITEMS = 5000;
const REPORTS_TO_HIDE = 3;

module.exports = function classwork(app) {
  const { route, state, db, log, HttpError, bad, isAdmin, getUser, cleanText, randomId, limiter, today, cal, bell, sameClass, isPlainObject, hasOwn, num } = app;
  if (!Array.isArray(state.classwork)) state.classwork = [];

  // The block of `user`'s that this item belongs to, or null.
  const blockOf = (user, item) => bell.BLOCK_KEYS.find((k) => sameClass(user.classes[k], item)) || null;
  const hidden = (item) => item.reports.length >= REPORTS_TO_HIDE;

  // Untrusted fields -> { kind, title, due, notes } or throws 400.
  function cleanFields(b, daysBack = 1) {
    if (!KINDS.includes(b.kind)) throw bad('Pick assignment, quiz or test');
    const title = cleanText(b.title, 100);
    if (!title) throw bad('Give it a title');
    const due = typeof b.due === 'string' ? b.due : '';
    if (cal.parseDate(due) === null) throw bad('Pick a valid due date');
    const t = today();
    if (due < cal.addDays(t, -daysBack) || due > cal.addDays(t, 180)) throw bad('Pick a due date in the next six months');
    return { kind: b.kind, title, due, notes: cleanText(b.notes, 300) };
  }

  function view(user, item) {
    const author = getUser(item.by);
    return {
      id: item.id, kind: item.kind, title: item.title, due: item.due, notes: item.notes,
      className: item.name, teacher: item.teacher, block: blockOf(user, item),
      by: author ? author.name : 'Former student',
      mine: item.by === user.id, canDelete: item.by === user.id || isAdmin(user),
      reported: item.reports.includes(user.id), hidden: hidden(item)
    };
  }

  route('GET', '/api/classwork', { auth: 'user' }, ({ user }) => state.classwork
    .filter((i) => blockOf(user, i) && (!hidden(i) || i.by === user.id || isAdmin(user)))
    .sort((a, b) => a.due.localeCompare(b.due) || a.created - b.created)
    .map((i) => view(user, i)));

  route('POST', '/api/classwork', { auth: 'user' }, ({ user, body }) => {
    const cls = typeof body.block === 'string' && bell.BLOCK_KEYS.includes(body.block) && hasOwn(user.classes, body.block) ? user.classes[body.block] : null;
    if (!cls) throw bad('Pick one of your classes');
    const f = cleanFields(body, 0);
    const twin = state.classwork.find((i) => sameClass(cls, i) && i.kind === f.kind && i.due === f.due && i.title.toLowerCase() === f.title.toLowerCase());
    if (twin) throw new HttpError(409, 'A classmate already posted that');
    if (state.classwork.length >= MAX_ITEMS) throw bad('The classwork board is full');
    if (!isAdmin(user) && !limiter.hit(`classwork:${user.id}`, 20, 86400e3)) throw new HttpError(429, 'You can post up to 20 items a day');
    const item = { id: randomId(), name: cls.name, teacher: cls.teacher, ...f, by: user.id, created: Date.now(), reports: [] };
    state.classwork.push(item);
    db.save();
    return view(user, item);
  });

  route('DELETE', '/api/classwork/:id', { auth: 'user' }, ({ user, params }) => {
    const i = state.classwork.findIndex((x) => x.id === params.id);
    if (i < 0) throw new HttpError(404, 'Not found');
    if (state.classwork[i].by !== user.id && !isAdmin(user)) throw new HttpError(403, 'Only the person who posted it (or an admin) can delete it');
    state.classwork.splice(i, 1);
    db.save();
    return { ok: true };
  });

  route('POST', '/api/classwork/:id/report', { auth: 'user' }, ({ user, params }) => {
    const item = state.classwork.find((x) => x.id === params.id);
    if (!item || !blockOf(user, item)) throw new HttpError(404, 'Not found');
    if (item.by === user.id) throw bad("You can't report your own post. Delete it instead.");
    if (!item.reports.includes(user.id)) {
      item.reports.push(user.id);
      if (item.reports.length === REPORTS_TO_HIDE) log(`Classwork ${item.id} hidden after ${REPORTS_TO_HIDE} reports`);
      db.save();
    }
    return { ok: true, hidden: hidden(item) };
  });

  // Admins: everything that has been reported, and a way to clear the reports.
  route('GET', '/api/admin/classwork', { auth: 'admin' }, () => state.classwork
    .filter((i) => i.reports.length)
    .sort((a, b) => b.reports.length - a.reports.length)
    .map((i) => {
      const author = getUser(i.by);
      return {
        id: i.id, kind: i.kind, title: i.title, due: i.due, notes: i.notes, className: i.name, teacher: i.teacher,
        by: author ? author.name : 'Former student', reports: i.reports.length, hidden: hidden(i)
      };
    }));
  route('POST', '/api/admin/classwork/:id/keep', { auth: 'admin' }, ({ user, params }) => {
    const item = state.classwork.find((x) => x.id === params.id);
    if (!item) throw new HttpError(404, 'Not found');
    item.reports = [];
    log(`Classwork ${item.id} reports cleared by admin ${user.id}`);
    db.save();
    return { ok: true };
  });

  return {
    status: () => ({ classwork: state.classwork.length, reportedClasswork: state.classwork.filter((i) => i.reports.length).length }),
    exportData: () => ({ classwork: state.classwork }),
    importData(data, users) {
      const out = [];
      for (const i of Array.isArray(data.classwork) ? data.classwork.slice(0, MAX_ITEMS) : []) {
        try {
          if (!isPlainObject(i) || typeof i.id !== 'string' || !/^[0-9a-f]{16}$/.test(i.id) || !hasOwn(users, i.by)) continue;
          const name = cleanText(i.name, 60);
          if (!name) continue;
          out.push({
            id: i.id, name, teacher: cleanText(i.teacher, 60), ...cleanFields(i, KEEP_DAYS), by: i.by, created: num(i.created),
            reports: Array.isArray(i.reports) ? [...new Set(i.reports.filter((r) => hasOwn(users, r)))] : []
          });
        } catch { /* skip invalid items */ }
      }
      state.classwork = out;
    },
    maintain() {
      const cutoff = cal.addDays(today(), -KEEP_DAYS);
      state.classwork = state.classwork.filter((i) => i.due >= cutoff);
    },
    forgetUser(id) {
      state.classwork = state.classwork.filter((i) => i.by !== id);
      for (const i of state.classwork) i.reports = i.reports.filter((r) => r !== id);
    }
  };
};
