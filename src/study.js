'use strict';
// Study sessions: a classmate plans a time and place to study for one of their classes; people in
// the same class (same name, and the same teacher when both are known) see it and say they're going.
// (Assignments themselves are each person's own Google Tasks: see src/tasks.js.)
const MAX_SESSIONS = 2000;
const MAX_GOING = 200;

module.exports = function study(app) {
  const { route, state, db, HttpError, bad, isAdmin, getUser, cleanText, randomId, limiter, today, cal, bell, sameClass, isPlainObject, hasOwn, num, checkWords, reports } = app;
  if (!Array.isArray(state.studySessions)) state.studySessions = [];
  const blockOf = (user, item) => bell.BLOCK_KEYS.find((k) => sameClass(user.classes[k], item)) || null;

  // ---------- study sessions ----------
  function cleanSession(b, daysBack = 0) {
    const title = cleanText(b.title, 100);
    if (!title) throw bad('Give the study session a title');
    const date = typeof b.date === 'string' ? b.date : '';
    if (cal.parseDate(date) === null) throw bad('Pick a valid date');
    const t = today();
    if (date < cal.addDays(t, -daysBack) || date > cal.addDays(t, 120)) throw bad('Pick a date in the next four months');
    const time = typeof b.time === 'string' ? b.time : '';
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('Invalid time');
    return { title, date, time, place: cleanText(b.place, 60), notes: cleanText(b.notes, 300) };
  }
  function sessionView(user, s) {
    const author = getUser(s.by);
    return {
      id: s.id, title: s.title, date: s.date, time: s.time, place: s.place, notes: s.notes,
      className: s.name, teacher: s.teacher, block: blockOf(user, s),
      by: author ? author.name : 'Former student', going: s.going.length, me: s.going.includes(user.id),
      people: s.going.map((id) => getUser(id)).filter(Boolean).map((u) => u.name),
      canDelete: s.by === user.id || isAdmin(user), mine: s.by === user.id, hidden: reports.hidden('study', s.id)
    };
  }
  reports.register('study', {
    locate(ref, user) {
      const s = state.studySessions.find((x) => x.id === ref.id);
      return s && blockOf(user, s) ? { id: s.id, ref: { id: s.id }, author: s.by, summary: `${s.name}: ${[s.title, s.place, s.notes].filter(Boolean).join(' · ')}`, link: '/classwork.html' } : null;
    },
    remove(ref) { state.studySessions = state.studySessions.filter((s) => s.id !== ref.id); },
    exists: (ref) => state.studySessions.some((s) => s.id === ref.id)
  });
  route('GET', '/api/study', { auth: 'user' }, ({ user }) => state.studySessions
    .filter((s) => blockOf(user, s) && reports.visible('study', s.id, s.by, user))
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
    .map((s) => sessionView(user, s)));
  route('POST', '/api/study', { auth: 'user' }, ({ user, body }) => {
    const cls = typeof body.block === 'string' && bell.BLOCK_KEYS.includes(body.block) && hasOwn(user.classes, body.block) ? user.classes[body.block] : null;
    if (!cls) throw bad('Pick one of your classes');
    const f = cleanSession(body);
    checkWords(f.title, f.place, f.notes);
    if (state.studySessions.length >= MAX_SESSIONS) throw bad('There are too many study sessions');
    if (!isAdmin(user) && !limiter.hit(`study:${user.id}`, 10, 86400e3)) throw new HttpError(429, 'You can plan up to 10 study sessions a day');
    const s = { id: randomId(), name: cls.name, teacher: cls.teacher, ...f, by: user.id, going: [user.id], created: Date.now() };
    state.studySessions.push(s);
    db.save();
    return sessionView(user, s);
  });
  route('POST', '/api/study/:id/going', { auth: 'user' }, ({ user, params, body }) => {
    const s = state.studySessions.find((x) => x.id === params.id);
    if (!s || !blockOf(user, s)) throw new HttpError(404, 'Study session not found');
    if (typeof body.on !== 'boolean') throw bad('Invalid request');
    const has = s.going.includes(user.id);
    if (body.on && !has) {
      if (s.going.length >= MAX_GOING) throw new HttpError(409, 'This study session is full');
      s.going.push(user.id);
    } else if (!body.on && has) s.going = s.going.filter((id) => id !== user.id);
    db.save();
    return sessionView(user, s);
  });
  route('DELETE', '/api/study/:id', { auth: 'user' }, ({ user, params }) => {
    const i = state.studySessions.findIndex((x) => x.id === params.id);
    if (i < 0) throw new HttpError(404, 'Study session not found');
    if (state.studySessions[i].by !== user.id && !isAdmin(user)) throw new HttpError(403, 'Only the person who planned it (or an admin) can delete it');
    state.studySessions.splice(i, 1);
    db.save();
    return { ok: true };
  });

  return {
    // for reminders (src/push.js): sessions starting soon, with who is going
    studySessions: () => state.studySessions,
    calendarItems: (user) => state.studySessions.filter((s) => s.going.includes(user.id)).map((s) => ({
      uid: `study-${s.id}`, date: s.date, time: s.time || null, title: `Study: ${s.title} (${s.name})`, description: s.notes, location: s.place
    })),
    status: () => ({ studySessions: state.studySessions.length }),
    exportData: () => ({ studySessions: state.studySessions }),
    importData(data, users) {
      const sessions = [];
      for (const s of Array.isArray(data.studySessions) ? data.studySessions.slice(0, MAX_SESSIONS) : []) {
        try {
          if (!isPlainObject(s) || typeof s.id !== 'string' || !/^[0-9a-f]{16}$/.test(s.id) || !hasOwn(users, s.by)) continue;
          const name = cleanText(s.name, 60);
          if (!name) continue;
          sessions.push({
            id: s.id, name, teacher: cleanText(s.teacher, 60), ...cleanSession(s, 2), by: s.by, created: num(s.created),
            going: Array.isArray(s.going) ? [...new Set(s.going.filter((id) => hasOwn(users, id)))].slice(0, MAX_GOING) : []
          });
        } catch { /* skip invalid sessions */ }
      }
      state.studySessions = sessions;
    },
    maintain() {
      const yesterday = cal.addDays(today(), -1);
      state.studySessions = state.studySessions.filter((s) => s.date >= yesterday);
    },
    forgetUser(id) {
      state.studySessions = state.studySessions.filter((s) => s.by !== id);
      for (const s of state.studySessions) s.going = s.going.filter((g) => g !== id);
    }
  };
};
