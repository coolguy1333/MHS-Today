'use strict';
// My to-do list: each student's own homework list ("Read ch. 4", "Permission slip"), with an optional
// due date and class. Private: only its owner ever sees it (admins don't, and it isn't in the audit
// log). It shows on Assignments, in "Due soon" on Today, on the Calendar page and calendar feeds, and
// in the evening-before reminder. Works without Google Tasks, which stays an optional extra.
//
// A to-do is { id, by: userId, title, due: 'YYYY-MM-DD' | null, block: color block | null, notes,
// done: time it was checked off | 0, created }.
const MAX_PER_PERSON = 200;
const KEEP_DONE_DAYS = 14;   // checked-off items stay this long (to undo, or to look back)
const KEEP_STALE_DAYS = 120; // never checked off, this long past due: tidied away

module.exports = function todos(app) {
  const { route, state, db, HttpError, bad, cleanText, randomId, today, cal, bell, isPlainObject, hasOwn, num } = app;
  if (!Array.isArray(state.todos)) state.todos = [];

  const mine = (user) => state.todos.filter((t) => t.by === user.id);
  // open ones first, soonest due first (no date last), then the ones done most recently
  const order = (a, b) => (!!a.done - !!b.done) || (a.done ? b.done - a.done : (a.due || '9999').localeCompare(b.due || '9999') || a.created - b.created);
  function view(user, t) {
    const c = t.block && hasOwn(user.classes, t.block) ? user.classes[t.block] : null;
    return { id: t.id, title: t.title, due: t.due, block: c ? t.block : null, className: c ? c.name : null, notes: t.notes, done: !!t.done };
  }
  // The fields present in `body`, cleaned. A new to-do needs a title.
  function fields(user, body, isNew) {
    const out = {};
    if (isNew || body.title !== undefined) {
      out.title = cleanText(body.title, 120);
      if (!out.title) throw bad('What do you need to do?');
    }
    if (body.due !== undefined) {
      if (body.due === null || body.due === '') out.due = null;
      else if (typeof body.due !== 'string' || cal.parseDate(body.due) === null) throw bad('Pick a valid due date');
      else if (body.due < cal.addDays(today(), -366) || body.due > cal.addDays(today(), 732)) throw bad('Pick a due date within two years');
      else out.due = body.due;
    } else if (isNew) out.due = null;
    if (body.block !== undefined) {
      if (body.block === null || body.block === '') out.block = null;
      else if (typeof body.block !== 'string' || !bell.BLOCK_KEYS.includes(body.block) || !hasOwn(user.classes, body.block)) throw bad('Pick one of your classes');
      else out.block = body.block;
    } else if (isNew) out.block = null;
    if (body.notes !== undefined) out.notes = cleanText(body.notes, 300);
    else if (isNew) out.notes = '';
    if (body.done !== undefined) {
      if (typeof body.done !== 'boolean') throw bad('Invalid request');
      out.done = body.done;
    }
    return out;
  }
  const find = (user, id) => {
    const t = state.todos.find((x) => x.id === id && x.by === user.id);
    if (!t) throw new HttpError(404, 'Not found'); // someone else's looks the same as none
    return t;
  };

  // auditBody: false throughout: what's on someone's own list is nobody else's business
  route('GET', '/api/todos', { auth: 'user' }, ({ user }) => mine(user).sort(order).map((t) => view(user, t)));
  route('POST', '/api/todos', { auth: 'user', auditBody: false }, ({ user, body }) => {
    const f = fields(user, body, true);
    const list = mine(user);
    if (list.filter((t) => !t.done).length >= MAX_PER_PERSON) throw bad('Your list is full. Check off or delete a few things first.');
    // adding the same thing twice (a double click, "Add to my list" again) keeps one
    const twin = list.find((t) => !t.done && t.title.toLowerCase() === f.title.toLowerCase() && t.due === f.due);
    if (twin) return view(user, twin);
    const t = { id: randomId(), by: user.id, title: f.title, due: f.due, block: f.block, notes: f.notes, done: f.done ? Date.now() : 0, created: Date.now() };
    state.todos.push(t);
    db.save();
    return view(user, t);
  });
  route('PUT', '/api/todos/:id', { auth: 'user', auditBody: false }, ({ user, params, body }) => {
    const t = find(user, params.id);
    const f = fields(user, body, false);
    if (f.done !== undefined) { t.done = f.done ? t.done || Date.now() : 0; delete f.done; }
    Object.assign(t, f);
    db.save();
    return view(user, t);
  });
  route('DELETE', '/api/todos/:id', { auth: 'user' }, ({ user, params }) => {
    const t = find(user, params.id);
    state.todos.splice(state.todos.indexOf(t), 1);
    db.save();
    return { deleted: true };
  });

  return {
    // for the evening-before reminder: what's on `user`'s list for `date`
    todosDueOn: (user, date) => state.todos.filter((t) => t.by === user.id && !t.done && t.due === date).map((t) => t.title),
    calendarItems: (user) => state.todos.filter((t) => t.by === user.id && !t.done && t.due && t.due >= cal.addDays(today(), -14))
      .map((t) => ({ uid: `todo-${t.id}`, kind: 'todo', date: t.due, time: null, title: `To do: ${t.title}`, description: t.notes })),
    userData: (user) => ({ todoList: mine(user).sort(order).map((t) => ({ title: t.title, due: t.due, notes: t.notes, done: !!t.done })) }),
    status: () => ({ todos: state.todos.length }),
    exportData: () => ({ todos: state.todos }),
    importData(data, users) {
      const out = [];
      const count = new Map();
      for (const t of Array.isArray(data.todos) ? data.todos.slice(0, 500000) : []) {
        if (!isPlainObject(t) || typeof t.id !== 'string' || !/^[0-9a-f]{16}$/.test(t.id) || !hasOwn(users, t.by)) continue;
        const title = cleanText(t.title, 120);
        if (!title || (count.get(t.by) || 0) >= MAX_PER_PERSON * 2) continue;
        count.set(t.by, (count.get(t.by) || 0) + 1);
        out.push({
          id: t.id, by: t.by, title, due: typeof t.due === 'string' && cal.parseDate(t.due) !== null ? t.due : null,
          block: bell.BLOCK_KEYS.includes(t.block) ? t.block : null, notes: cleanText(t.notes, 300), done: num(t.done), created: num(t.created)
        });
      }
      const seen = new Set();
      state.todos = out.filter((t) => !seen.has(t.id) && seen.add(t.id));
      return {};
    },
    maintain() {
      const doneBefore = Date.now() - KEEP_DONE_DAYS * 86400e3;
      const staleBefore = cal.addDays(today(), -KEEP_STALE_DAYS);
      state.todos = state.todos.filter((t) => (t.done ? t.done >= doneBefore : !t.due || t.due >= staleBefore));
    },
    forgetUser(id) { state.todos = state.todos.filter((t) => t.by !== id); }
  };
};
