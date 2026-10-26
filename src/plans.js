'use strict';
// Lesson plans: a teacher writes, for each of their classes and school day, what the class is doing
// ("Poetry unit: read pp. 40-52", "Quiz on chapter 3"). Their students see it next to that class
// on Today and on the Calendar page (and in the classes calendar feed).
//
// A plan is { id, by: teacherId, block, name: the class name, date, text }. A student sees it when
// they have a class in the same block with the same name and the teacher's last name as its teacher
// (from Google, or the last word of the teacher's display name).
const MAX_PLANS = 20000;
const KEEP_DAYS = 60; // removed this long after their day

module.exports = function plans(app) {
  const { route, state, db, HttpError, bad, getUser, cleanText, randomId, today, cal, bell, isPlainObject, hasOwn, num, checkWords, isTeacher } = app;
  if (!Array.isArray(state.plans)) state.plans = [];

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lastName = (t) => bell.teacherKey(t.familyName) || bell.teacherKey(t.name);
  // does `user` (a student) have the class this plan is for?
  function forStudent(user, p) {
    const c = hasOwn(user.classes, p.block) ? user.classes[p.block] : null;
    const t = getUser(p.by);
    return !!c && !!t && !isTeacher(user) && norm(c.name) === norm(p.name) && !!bell.teacherKey(c.teacher) && bell.teacherKey(c.teacher) === lastName(t);
  }
  const visible = (user, p) => (isTeacher(user) ? p.by === user.id : forStudent(user, p));
  const view = (p) => {
    const t = getUser(p.by);
    return { id: p.id, date: p.date, block: p.block, className: p.name, text: p.text, teacher: t ? t.name : 'Former teacher', updated: p.updated };
  };
  // each line cleaned on its own, so line breaks survive
  const cleanPlanText = (t) => (typeof t === 'string' ? t.split(/\r?\n/) : []).map((l) => cleanText(l, 600)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 600);
  const okDate = (d, t) => cal.parseDate(d) !== null && d >= cal.addDays(t, -KEEP_DAYS) && d <= cal.addDays(t, 366);

  // ?from=&to= (at most about three months): your plans (teachers) or your teachers' plans (students)
  route('GET', '/api/plans', { auth: 'user' }, ({ user, url }) => {
    const t = today();
    const from = cal.parseDate(url.searchParams.get('from')) !== null ? url.searchParams.get('from') : cal.addDays(t, -7);
    const to = cal.parseDate(url.searchParams.get('to')) !== null ? url.searchParams.get('to') : cal.addDays(t, 30);
    if (to < from || cal.parseDate(to) - cal.parseDate(from) > 100 * 86400e3) throw bad('Pick up to about three months');
    return state.plans.filter((p) => p.date >= from && p.date <= to && visible(user, p))
      .sort((a, b) => a.date.localeCompare(b.date) || bell.BLOCK_KEYS.indexOf(a.block) - bell.BLOCK_KEYS.indexOf(b.block)).map(view);
  });
  // A teacher sets the plan for one of their classes on one day; empty text removes it.
  route('PUT', '/api/plans', { auth: 'user' }, ({ user, body }) => {
    if (!isTeacher(user)) throw new HttpError(403, 'Only teachers add lesson plans');
    const block = typeof body.block === 'string' && bell.BLOCK_KEYS.includes(body.block) && hasOwn(user.classes, body.block) ? body.block : null;
    if (!block) throw bad('Pick one of your classes');
    const date = typeof body.date === 'string' ? body.date : '';
    if (!okDate(date, today())) throw bad('Pick a day within the next year');
    const text = cleanPlanText(body.text);
    checkWords(text);
    const i = state.plans.findIndex((p) => p.by === user.id && p.block === block && p.date === date);
    if (!text) {
      if (i >= 0) { state.plans.splice(i, 1); db.save(); }
      return { deleted: true };
    }
    const name = user.classes[block].name;
    if (i >= 0) Object.assign(state.plans[i], { text, name, updated: Date.now() });
    else {
      if (state.plans.length >= MAX_PLANS) throw bad('There are too many lesson plans right now');
      state.plans.push({ id: randomId(), by: user.id, block, name, date, text, updated: Date.now() });
    }
    db.save();
    return view(state.plans[i >= 0 ? i : state.plans.length - 1]);
  });

  return {
    calendarItems: (user) => state.plans.filter((p) => p.date >= cal.addDays(today(), -14) && visible(user, p)).map((p) => ({
      uid: `plan-${p.id}`, kind: 'plan', date: p.date, time: null, title: `${p.name}: ${p.text.split('\n')[0].slice(0, 80)}`, description: p.text
    })),
    userData: (user) => ({ lessonPlans: state.plans.filter((p) => p.by === user.id).map((p) => ({ date: p.date, class: p.name, text: p.text })) }),
    status: () => ({ plans: state.plans.length }),
    exportData: () => ({ plans: state.plans }),
    importData(data, users) {
      const out = [];
      const t = today();
      for (const p of Array.isArray(data.plans) ? data.plans.slice(0, MAX_PLANS) : []) {
        if (!isPlainObject(p) || typeof p.id !== 'string' || !/^[0-9a-f]{16}$/.test(p.id) || out.some((x) => x.id === p.id)) continue;
        if (!hasOwn(users, p.by) || users[p.by].role !== 'teacher' || !bell.BLOCK_KEYS.includes(p.block) || !okDate(p.date, t)) continue;
        const text = cleanPlanText(p.text), name = cleanText(p.name, 60);
        if (text && name && !out.some((x) => x.by === p.by && x.block === p.block && x.date === p.date)) out.push({ id: p.id, by: p.by, block: p.block, name, date: p.date, text, updated: num(p.updated) });
      }
      state.plans = out;
      return {};
    },
    maintain() {
      const cutoff = cal.addDays(today(), -KEEP_DAYS);
      state.plans = state.plans.filter((p) => p.date >= cutoff);
    },
    forgetUser(id) { state.plans = state.plans.filter((p) => p.by !== id); }
  };
};
