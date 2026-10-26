'use strict';
// Class events: classmates post tests, quizzes, assignments and projects for a class. Only people in
// the same class see them: the same class name and the same teacher (by last name; posting needs a
// teacher on your class), in whichever block each person has it (other hours of it too). They show on the Assignments page, next to the class
// on Today, in calendar feeds, and in the evening-before reminder. Reportable like everything else.
const KINDS = ['test', 'quiz', 'assignment', 'project'];
const MAX_ITEMS = 3000;
const KEEP_DAYS = 14; // removed this long after they're due

module.exports = function classEvents(app) {
  const { route, state, db, HttpError, bad, isAdmin, getUser, cleanText, randomId, limiter, today, cal, bell, isPlainObject, hasOwn, num, checkWords, reports, isTeacher } = app;
  if (!Array.isArray(state.classEvents)) state.classEvents = [];

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Same class name, same teacher (both must have one); the block doesn't matter.
  const classMatch = (cls, item) => !!cls && norm(cls.name) === norm(item.name) && !!bell.teacherKey(cls.teacher) && bell.teacherKey(cls.teacher) === bell.teacherKey(item.teacher);
  // the block where `user` has that class (theirs, which may not be the poster's), or null
  const blockIn = (user, item) => (user ? bell.BLOCK_KEYS.find((k) => hasOwn(user.classes, k) && classMatch(user.classes[k], item)) || null : null);
  const inClass = (user, item) => !!blockIn(user, item);
  const shows = (user, item) => !isTeacher(user) && inClass(user, item) && reports.visible('classwork', item.id, item.by, user); // students only
  const view = (user, item) => {
    const author = getUser(item.by);
    return {
      id: item.id, kind: item.kind, title: item.title, due: item.due, notes: item.notes, block: blockIn(user, item) || item.block, className: item.name, teacher: item.teacher,
      by: author ? author.name : 'Former student', mine: item.by === user.id, canDelete: item.by === user.id || isAdmin(user), hidden: reports.hidden('classwork', item.id)
    };
  };
  const byDue = (a, b) => a.due.localeCompare(b.due) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind);

  function cleanItem(b, daysBack = 1) {
    if (!KINDS.includes(b.kind)) throw bad('Pick test, quiz, assignment or project');
    const title = cleanText(b.title, 100);
    if (!title) throw bad('Give it a title, like "Unit 3 quiz"');
    const due = typeof b.due === 'string' ? b.due : '';
    if (cal.parseDate(due) === null) throw bad('Pick the date it\'s due');
    const t = today();
    if (due < cal.addDays(t, -daysBack) || due > cal.addDays(t, 180)) throw bad('Pick a date in the next six months');
    return { kind: b.kind, title, due, notes: cleanText(b.notes, 300) };
  }

  // Your classes' upcoming tests and assignments (and the last few days').
  route('GET', '/api/classwork', { auth: 'user' }, ({ user }) => {
    const from = cal.addDays(today(), -3);
    return state.classEvents.filter((i) => i.due >= from && shows(user, i)).sort(byDue).map((i) => view(user, i));
  });
  route('POST', '/api/classwork', { auth: 'user' }, ({ user, body }) => {
    const block = typeof body.block === 'string' && bell.BLOCK_KEYS.includes(body.block) && hasOwn(user.classes, body.block) ? body.block : null;
    if (!block) throw bad('Pick one of your classes');
    const cls = user.classes[block];
    if (!bell.teacherKey(cls.teacher)) throw bad(`Add the teacher for ${cls.name} on My Schedule first, so it goes to the right class`);
    const f = cleanItem(body);
    checkWords(f.title, f.notes);
    const twin = state.classEvents.find((i) => classMatch(cls, i) && i.kind === f.kind && i.due === f.due && norm(i.title) === norm(f.title));
    if (twin) throw new HttpError(409, 'A classmate already added that');
    if (state.classEvents.length >= MAX_ITEMS) throw bad('There are too many class events right now');
    if (!isAdmin(user) && !limiter.hit(`classwork:${user.id}`, 15, 86400e3)) throw new HttpError(429, 'You can add up to 15 a day');
    const item = { id: randomId(), block, name: cls.name, teacher: cls.teacher, ...f, by: user.id, created: Date.now() };
    state.classEvents.push(item);
    db.save();
    return view(user, item);
  });
  route('DELETE', '/api/classwork/:id', { auth: 'user' }, ({ user, params }) => {
    const i = state.classEvents.findIndex((x) => x.id === params.id);
    if (i < 0 || !(inClass(user, state.classEvents[i]) || isAdmin(user))) throw new HttpError(404, 'Not found');
    if (state.classEvents[i].by !== user.id && !isAdmin(user)) throw new HttpError(403, 'Only the person who added it (or an admin) can delete it');
    state.classEvents.splice(i, 1);
    db.save();
    return { ok: true };
  });

  reports.register('classwork', {
    locate(ref, user) {
      const i = state.classEvents.find((x) => x.id === ref.id);
      return i && inClass(user, i) ? { id: i.id, ref: { id: i.id }, author: i.by, summary: `${i.name} (${i.teacher}): ${i.kind} "${i.title}" due ${i.due}${i.notes ? ` · ${i.notes}` : ''}`, link: '/classwork.html' } : null;
    },
    remove(ref) { state.classEvents = state.classEvents.filter((i) => i.id !== ref.id); },
    exists: (ref) => state.classEvents.some((i) => i.id === ref.id)
  });

  const KIND_LABEL = { test: 'Test', quiz: 'Quiz', assignment: 'Assignment', project: 'Project' };
  return {
    // for the evening-before reminder: what's due on `date` in `user`'s classes
    classEventsDueOn: (user, date) => state.classEvents.filter((i) => i.due === date && shows(user, i)).map((i) => `${KIND_LABEL[i.kind]}: ${i.title} (${i.name})`),
    calendarItems: (user) => state.classEvents.filter((i) => i.due >= cal.addDays(today(), -14) && shows(user, i))
      .map((i) => ({ uid: `cw-${i.id}`, kind: 'classwork', date: i.due, time: null, title: `${KIND_LABEL[i.kind]}: ${i.title} (${i.name})`, description: i.notes })),
    userData: (user) => ({ classEventsPosted: state.classEvents.filter((i) => i.by === user.id).map((i) => ({ kind: i.kind, title: i.title, due: i.due, class: i.name, notes: i.notes })) }),
    status: () => ({ classEvents: state.classEvents.length }),
    exportData: () => ({ classEvents: state.classEvents }),
    importData(data, users) {
      const out = [];
      for (const i of Array.isArray(data.classEvents) ? data.classEvents.slice(0, MAX_ITEMS) : []) {
        try {
          if (!isPlainObject(i) || typeof i.id !== 'string' || !/^[0-9a-f]{16}$/.test(i.id) || out.some((x) => x.id === i.id)) continue;
          if (!bell.BLOCK_KEYS.includes(i.block) || !hasOwn(users, i.by)) continue;
          const name = cleanText(i.name, 60), teacher = cleanText(i.teacher, 60);
          if (!name || !teacher) continue;
          out.push({ id: i.id, block: i.block, name, teacher, ...cleanItem(i, KEEP_DAYS), by: i.by, created: num(i.created) });
        } catch { /* skip a bad one */ }
      }
      state.classEvents = out;
      return {};
    },
    maintain() {
      const cutoff = cal.addDays(today(), -KEEP_DAYS);
      state.classEvents = state.classEvents.filter((i) => i.due >= cutoff);
    },
    forgetUser(id) { state.classEvents = state.classEvents.filter((i) => i.by !== id); }
  };
};
