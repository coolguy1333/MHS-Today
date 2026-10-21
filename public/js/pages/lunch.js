// Lunch: your lunch (time, a countdown, where A/B/C fall in Hour 4, and which friends are there),
// the day's menu as one card per station, and the week at a glance. The menu comes from the
// district's menu service through our server.
(async function () {
  renderNav('lunch');
  await requireLogin();
  const { dayInfo, nextSchoolDay, addDays } = MHSCalendar;
  const { formatTime, lunchFor, lunchTimes, timeToMinutes, LUNCH_NAMES } = MHSBell;
  const S = { info: null, me: null, classes: {}, friends: [], viewDate: null, week: {} };

  function model() {
    const cal = S.info.calendar;
    const now = schoolClock(S.info);
    const todayInfo = dayInfo(cal, now.date);
    const viewDate = S.viewDate || (todayInfo.schoolDay ? now.date : nextSchoolDay(cal, now.date)) || now.date;
    return { cal, now, viewDate, view: dayInfo(cal, viewDate), isToday: viewDate === now.date };
  }

  // ---- a picture for each station, from its name or its first dish
  const ICONS = [[/pizza/i, '🍕'], [/burger|grill/i, '🍔'], [/grab|deli|sub|sandwich|wrap/i, '🥪'], [/salad|garden|veg/i, '🥗'], [/taco|nacho|mexican|burrito/i, '🌮'],
    [/pasta|noodle|spaghetti|mac/i, '🍝'], [/chicken|tender|wing/i, '🍗'], [/soup|chili/i, '🍲'], [/breakfast|pancake|waffle/i, '🥞'], [/dessert|cookie|bake/i, '🍪'],
    [/fruit/i, '🍎'], [/milk|drink|beverage/i, '🥛'], [/asian|rice|teriyaki/i, '🍚']];
  const iconFor = (s) => (ICONS.find(([re]) => re.test(`${s.title} ${s.items.map((i) => i.name).join(' ')}`)) || [, '🍽️'])[1];
  // 'Pizza, Pizza ($3.85)' -> { name: 'Pizza, Pizza', price: '$3.85' }
  const splitPrice = (t) => { const m = /^(.*?)\s*\((\$\d+(?:\.\d\d)?)\)\s*$/.exec(t || ''); return m ? { name: m[1], price: m[2] } : { name: t || 'Menu', price: null }; };
  const mainDish = (data) => { for (const s of data.sections || []) { const f = s.items.find((i) => i.kind !== 'note'); if (f) return f.name; } return null; };

  function renderHead(m) {
    const prev = nextSchoolDay(m.cal, m.viewDate, -1);
    const next = nextSchoolDay(m.cal, m.viewDate, 1);
    const v = m.view;
    // Monday to Friday of the week shown, each with its main dish
    const wd = new Date(MHSCalendar.parseDate(m.viewDate)).getUTCDay();
    const monday = addDays(m.viewDate, wd === 0 ? 1 : wd === 6 ? 2 : 1 - wd);
    const days = [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
    fill($('lunch-head'),
      h('h1', { class: 'day-title' }, `Lunch · ${fmtLongDay(m.viewDate)}`),
      h('p', { class: 'day-sub muted' }, v.schoolDay
        ? [v.dayLetter ? h('span', { class: 'badge blue' }, `Day ${v.dayLetter}`) : null, ' ', scheduleTitle(v.scheduleType)]
        : (v.reason === 'weekend' ? 'Weekend' : 'No school') + (v.label ? ` – ${v.label}` : '')),
      h('div', { class: 'lunch-week', role: 'group', 'aria-label': 'This week' }, days.map((d) => {
        const di = dayInfo(m.cal, d);
        const data = S.week[d];
        const dish = di.schoolDay ? (data ? mainDish(data) || 'No menu' : '…') : di.label || 'No school';
        return h('button', {
          type: 'button', class: ['lw-day', d === m.viewDate ? 'on' : null, di.schoolDay ? null : 'off', d === m.now.date ? 'today' : null].filter(Boolean).join(' '),
          'aria-pressed': String(d === m.viewDate), disabled: !di.schoolDay, onclick: () => go(d)
        }, h('span', { class: 'lw-date' }, fmtShortDay(d).replace(/,.*/, ''), ' ', `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`), h('span', { class: 'lw-dish' }, dish));
      })),
      h('div', { class: 'day-nav' },
        prev ? h('button', { class: 'btn secondary small', type: 'button', 'aria-label': 'Previous school day', onclick: () => go(prev) }, '← Previous') : null,
        S.viewDate ? h('button', { class: 'btn small', type: 'button', onclick: () => go(null) }, 'Back to today') : null,
        next ? h('button', { class: 'btn secondary small', type: 'button', 'aria-label': 'Next school day', onclick: () => go(next) }, 'Next →') : null));
    loadWeek(days);
  }

  // ---- your lunch: big time, a countdown today, A/B/C on a line through Hour 4, friends there
  function renderMine(m) {
    const box = $('my-lunch');
    const v = m.view;
    if (!v.schoolDay || !v.dayLetter) { fill(box, h('p', { class: 'muted' }, v.schoolDay ? "The day letter isn't set, so your lunch can't be worked out." : 'No school this day.')); return; }
    const lunch = lunchFor(S.classes, v.dayLetter);
    if (!lunch) { fill(box, h('h2', null, 'Your lunch'), h('p', { class: 'muted' }, 'Pick your A, B or C lunch on ', h('a', { href: 'schedule.html' }, 'My classes'), ' to see it here.')); return; }
    const t = lunchTimes(v.scheduleType, lunch);
    const start = timeToMinutes(t.start), end = timeToMinutes(t.end);
    let live = null;
    if (m.isToday) {
      const n = m.now.minutes;
      live = n < start ? `Starts in ${fmtMinutes(start - n)}` : n < end ? `Now · ${fmtMinutes(end - n)} left` : 'Done for today';
    }
    const all = LUNCH_NAMES.map((l) => ({ l, ...lunchTimes(v.scheduleType, l) }));
    const first = timeToMinutes(all[0].start), last = timeToMinutes(all[all.length - 1].end);
    const pct = (x) => `${((x - first) / (last - first)) * 100}%`;
    const friends = S.friends.filter((f) => friendLunch(f, v.dayLetter) === lunch);
    fill(box,
      h('div', { class: 'lh-top' },
        h('div', { class: 'lh-letter', 'aria-hidden': 'true' }, lunch),
        h('div', null,
          h('div', { class: 'small muted' }, 'Your lunch'),
          h('div', { class: 'lh-time' }, `${lunch} Lunch · ${formatTime(t.start)} – ${formatTime(t.end)}`),
          live ? h('div', { class: 'lh-live' + (live.startsWith('Now') ? ' now' : '') }, live) : null)),
      h('div', { class: 'lunch-line', role: 'img', 'aria-label': all.map((x) => `${x.l} Lunch ${formatTime(x.start)} to ${formatTime(x.end)}`).join(', ') },
        all.map((x) => h('div', {
          class: 'll-seg' + (x.l === lunch ? ' mine' : ''),
          style: { left: pct(timeToMinutes(x.start)), width: `calc(${pct(timeToMinutes(x.end))} - ${pct(timeToMinutes(x.start))})` }
        }, h('strong', null, x.l), h('span', null, formatTime(x.start).replace(/ [AP]M/, '')))),
        m.isToday && m.now.minutes >= first && m.now.minutes <= last ? h('div', { class: 'll-now', style: { left: pct(m.now.minutes) }, title: 'Now' }) : null),
      h('div', { class: 'lh-friends' }, friends.length
        ? [h('span', { class: 'small muted' }, 'Friends at your lunch'), h('div', { class: 'lh-faces' }, friends.map((f) => h('span', { class: 'lh-face' }, avatarEl(f, 28), f.name)))]
        : h('span', { class: 'small muted' }, 'None of your friends share this lunch.')));
  }

  function renderMenu(data) {
    const box = $('menu');
    if (!data.available) {
      const why = { 'not-configured': 'The lunch menu is not set up on this site.', unavailable: "The menu service couldn't be reached. Try again in a few minutes." }[data.error];
      fill(box, h('p', { class: 'muted' }, why || 'No lunch menu is posted for this day.'));
    } else {
      fill(box, data.sections.map((s) => {
        const { name, price } = splitPrice(s.title);
        return h('section', { class: 'station' },
          h('div', { class: 'st-head' }, h('span', { class: 'st-icon', 'aria-hidden': 'true' }, iconFor(s)), h('h3', null, name), price ? h('span', { class: 'st-price' }, price) : null),
          h('ul', { class: 'st-items' }, s.items.map((it) => h('li', { class: it.kind === 'note' ? 'note' : null }, it.name))));
      }));
    }
    const src = $('menu-source');
    src.hidden = !data.source;
    if (data.source) fill(src, 'From the ', h('a', { href: data.source, target: '_blank', rel: 'noopener noreferrer' }, 'high school lunch menu'), ' (Health-e Pro). Prices and items can change.');
  }

  // the week's menus, once each (the server caches the month, so these are quick)
  async function loadWeek(days) {
    const missing = days.filter((d) => !(d in S.week) && dayInfo(S.info.calendar, d).schoolDay);
    if (!missing.length) return;
    for (const d of missing) S.week[d] = null;
    await Promise.all(missing.map((d) => api('GET', `/api/lunch?date=${d}`).then((r) => { S.week[d] = r; }).catch(() => { S.week[d] = { sections: [] }; })));
    renderHead(model());
  }

  let seq = 0;
  async function renderAll() {
    const m = model();
    renderHead(m);
    renderMine(m);
    const mine = ++seq;
    if (S.week[m.viewDate]) { renderMenu(S.week[m.viewDate]); return; }
    fill($('menu'), h('p', { class: 'muted' }, 'Loading…'));
    try {
      const data = await api('GET', `/api/lunch?date=${m.viewDate}`);
      S.week[m.viewDate] = data;
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
    const [c, f] = await Promise.all([api('GET', '/api/classes'), api('GET', '/api/friends')]);
    S.classes = c; S.friends = f.friends;
  } catch (e) {
    fill($('lunch-head'), h('p', { class: 'notice error' }, e.message));
    return;
  }
  renderAll();
  // the countdown and the "now" mark move once a minute (not while the tab is hidden)
  setInterval(() => { if (!document.hidden && !S.viewDate) renderMine(model()); }, 60000);
})();
