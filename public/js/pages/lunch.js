// Lunch: the day's menu from the district's menu service, your lunch time, and who shares it.
(async function () {
  renderNav('lunch');
  const { dayInfo, nextSchoolDay } = MHSCalendar;
  const { formatTime, lunchFor, lunchTimes } = MHSBell;
  const S = { info: null, me: null, classes: {}, friends: [], viewDate: null };

  function model() {
    const cal = S.info.calendar;
    const now = schoolClock(S.info);
    const todayInfo = dayInfo(cal, now.date);
    const viewDate = S.viewDate || (todayInfo.schoolDay ? now.date : nextSchoolDay(cal, now.date)) || now.date;
    return { cal, now, viewDate, view: dayInfo(cal, viewDate), isToday: viewDate === now.date };
  }

  function renderHead(m) {
    const prev = nextSchoolDay(m.cal, m.viewDate, -1);
    const next = nextSchoolDay(m.cal, m.viewDate, 1);
    const v = m.view;
    fill($('lunch-head'),
      h('h1', { class: 'day-title' }, `Lunch · ${fmtLongDay(m.viewDate)}`),
      h('p', { class: 'day-sub muted' }, v.schoolDay
        ? [v.dayLetter ? h('span', { class: 'badge blue' }, `Day ${v.dayLetter}`) : null, ' ', SCHEDULE_NAMES[v.scheduleType] || '']
        : (v.reason === 'weekend' ? 'Weekend' : 'No school') + (v.label ? ` – ${v.label}` : '')),
      h('div', { class: 'day-nav' },
        prev ? h('button', { class: 'btn secondary small', type: 'button', 'aria-label': 'Previous school day', onclick: () => go(prev) }, '← Previous') : null,
        S.viewDate ? h('button', { class: 'btn small', type: 'button', onclick: () => go(null) }, 'Back to today') : null,
        next ? h('button', { class: 'btn secondary small', type: 'button', 'aria-label': 'Next school day', onclick: () => go(next) }, 'Next →') : null));
  }

  function renderMine(m) {
    const box = $('my-lunch');
    const v = m.view;
    if (!S.me) { fill(box, h('p', { class: 'muted' }, h('a', { href: 'login.html?next=lunch.html' }, 'Sign in'), ' to see your lunch time and who you eat with.')); return; }
    if (!v.schoolDay || !v.dayLetter) { fill(box, h('p', { class: 'muted' }, v.schoolDay ? "The day letter isn't set, so your lunch can't be worked out." : 'No school this day.')); return; }
    const lunch = lunchFor(S.classes, v.dayLetter);
    if (!lunch) { fill(box, h('p', { class: 'muted' }, 'Pick your A, B or C lunch on ', h('a', { href: 'schedule.html' }, 'My Schedule'), ' to see it here.')); return; }
    const t = lunchTimes(v.scheduleType, lunch);
    const buddies = S.friends.filter((f) => friendLunch(f, v.dayLetter) === lunch).map((f) => f.name);
    fill(box,
      h('div', { class: 'status-big' }, `${lunch} Lunch · ${formatTime(t.start)} – ${formatTime(t.end)}`),
      h('p', { class: 'muted' }, buddies.length ? `With ${buddies.join(', ')}` : 'None of your friends share this lunch.'));
  }

  function renderMenu(data) {
    const box = $('menu');
    if (!data.available) {
      const why = { 'not-configured': 'The lunch menu is not set up on this site.', unavailable: "The menu service couldn't be reached. Try again in a few minutes." }[data.error];
      fill(box, h('p', { class: 'muted' }, why || 'No lunch menu is posted for this day.'));
    } else {
      fill(box, data.sections.map((s) => h('section', { class: 'menu-section' },
        s.title ? h('h3', null, s.title) : null,
        h('ul', { class: 'menu-items' }, s.items.map((it) => h('li', { class: it.kind === 'note' ? 'note' : null }, it.name))))));
    }
    const src = $('menu-source');
    src.hidden = !data.source;
    if (data.source) fill(src, 'From the district\'s ', h('a', { href: data.source, target: '_blank', rel: 'noopener noreferrer' }, 'My School Menus'), ' page. Prices and items can change.');
  }

  let seq = 0;
  async function renderAll() {
    const m = model();
    renderHead(m);
    renderMine(m);
    const mine = ++seq;
    fill($('menu'), h('p', { class: 'muted' }, 'Loading…'));
    try {
      const data = await api('GET', `/api/lunch?date=${m.viewDate}`);
      if (mine === seq) renderMenu(data);
    } catch (e) {
      if (mine === seq) fill($('menu'), h('p', { class: 'notice error' }, e.message));
    }
  }
  function go(date) {
    S.viewDate = date && date !== schoolClock(S.info).date ? date : null;
    renderAll();
  }

  try {
    const [info, me] = await Promise.all([loadCalendar(), getMe()]);
    S.info = info; S.me = me.user;
    if (S.me) {
      const [c, f] = await Promise.all([api('GET', '/api/classes'), api('GET', '/api/friends')]);
      S.classes = c; S.friends = f.friends;
    }
  } catch (e) {
    fill($('lunch-head'), h('p', { class: 'notice error' }, e.message));
    return;
  }
  renderAll();
})();
