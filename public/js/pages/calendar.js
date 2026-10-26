// Calendar: one month with everything on it: events you can see (your groups' too), tests and
// assignments for your classes, your study sessions, school days (with the day letter) and days off.
// Phones get a list of the days that have something; a computer gets the month, and a click on a day
// lists it below. "Add to Google Calendar" subscribes Google to your private calendar link.
(async function () {
  renderNav('calendar');
  await requireLogin();
  const { addDays, dayInfo } = MHSCalendar;
  const KINDS = [['event', 'Events'], ['group', 'My groups'], ['classwork', 'Tests & assignments'], ['plan', 'Lesson plans'], ['study', 'Study'], ['off', 'Days off']];
  const shown = new Set(KINDS.map(([k]) => k));
  let info, items = [], month = null, picked = null;

  const monthOf = (d) => d.slice(0, 7);
  const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
  const today = () => schoolClock(info).date;
  // the items on one date (multi-day events on every day they cover)
  const on = (d) => items.filter((i) => shown.has(i.kind) && i.date <= d && (i.endDate || i.date) >= d)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const when = (i) => (i.time ? `${MHSBell.formatTime(i.time)}${i.endTime && !i.endDate ? ` – ${MHSBell.formatTime(i.endTime)}` : ''}` : 'All day');
  const dayNote = (di) => (!di.schoolDay ? (di.reason === 'weekend' ? '' : di.label || 'No school')
    : [di.dayLetter ? `Day ${di.dayLetter}` : '', di.scheduleType !== 'daily' ? MHSBell.scheduleName(di.scheduleType) : ''].filter(Boolean).join(' · '));

  function renderFilters() {
    fill($('cal-filters'), KINDS.map(([k, label]) => h('button', {
      class: `cal-filter kind-${k}` + (shown.has(k) ? ' on' : ''), type: 'button', 'aria-pressed': String(shown.has(k)),
      onclick: () => { if (shown.has(k)) shown.delete(k); else shown.add(k); renderFilters(); render(); }
    }, h('span', { class: 'cal-dot', 'aria-hidden': 'true' }), label)));
  }
  function chip(i) {
    return h('div', { class: `cal-chip kind-${i.kind}`, title: [i.title, i.group, i.location].filter(Boolean).join(' · ') },
      i.time ? h('span', { class: 'cal-time' }, MHSBell.formatTime(i.time).replace(':00', '').replace(' ', '').toLowerCase()) : null, i.title);
  }
  function dayList(d) {
    const di = dayInfo(info.calendar, d);
    const list = on(d);
    const off = shown.has('off') && !di.schoolDay && di.reason !== 'weekend';
    return h('div', { class: 'cal-day-list' + (d === today() ? ' today' : '') },
      h('h3', null, fmtLongDay(d), ' ', h('span', { class: 'small muted' }, dayNote(di))),
      off ? h('div', { class: 'cal-item kind-off' }, h('strong', null, di.label || 'No school')) : null,
      list.map((i) => h('div', { class: `cal-item kind-${i.kind}` },
        h('div', { class: 'small muted' }, when(i), i.group ? ` · ${i.group}` : '', i.location ? ` · ${i.location}` : ''),
        h('strong', null, i.title),
        (i.details !== undefined ? i.details : i.description) ? h('div', { class: 'small' }, i.details !== undefined ? i.details : i.description) : null)),
      !list.length && !off ? h('p', { class: 'small muted' }, 'Nothing on this day.') : null);
  }

  function render() {
    const [y, m] = month.split('-').map(Number);
    $('cal-title').textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(Date.UTC(y, m - 1, 1));
    const t = today();
    // the month, Monday to Sunday, whole weeks
    let d = `${month}-01`;
    while (utcDate(d).getUTCDay() !== 1) d = addDays(d, -1);
    const cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => h('div', { class: 'cal-head' }, w));
    const agenda = [];
    for (; monthOf(d) <= month || utcDate(d).getUTCDay() !== 1; d = addDays(d, 1)) {
      const di = dayInfo(info.calendar, d);
      const list = on(d);
      const inMonth = monthOf(d) === month;
      const off = shown.has('off') && !di.schoolDay && di.reason !== 'weekend';
      const day = d;
      cells.push(h('button', {
        type: 'button', class: ['cal-cell', inMonth ? null : 'other', di.reason === 'weekend' ? 'weekend' : null, off ? 'off' : null, d === t ? 'today' : null, d === picked ? 'picked' : null].filter(Boolean).join(' '),
        'aria-label': `${fmtLongDay(d)}${dayNote(di) ? `, ${dayNote(di)}` : ''}: ${list.length ? `${list.length} thing${list.length === 1 ? '' : 's'}` : 'nothing'}`,
        'aria-pressed': String(d === picked), onclick: () => { picked = picked === day ? null : day; render(); }
      },
      h('span', { class: 'cal-num' }, String(Number(d.slice(8))), di.schoolDay && di.dayLetter ? h('span', { class: 'cal-letter' }, di.dayLetter) : null),
      off ? h('span', { class: 'cal-off' }, di.label || 'No school') : null,
      list.slice(0, 3).map(chip),
      list.length > 3 ? h('span', { class: 'cal-more' }, `+${list.length - 3} more`) : null));
      if (inMonth && (list.length || off) && d >= (monthOf(t) === month ? t : `${month}-01`)) agenda.push(d);
    }
    fill($('cal-grid'), cells);
    // below the month: the picked day; on a phone, every day from today (or the 1st) with something on it
    fill($('cal-agenda'),
      picked ? h('div', { class: 'cal-picked' }, dayList(picked)) : null,
      h('div', { class: 'cal-phone-list' }, agenda.length ? agenda.map(dayList) : h('p', { class: 'muted' }, 'Nothing else this month.')));
  }

  $('cal-prev').addEventListener('click', () => { month = shiftMonth(month, -1); picked = null; render(); });
  $('cal-next').addEventListener('click', () => { month = shiftMonth(month, 1); picked = null; render(); });
  $('cal-today').addEventListener('click', () => { month = monthOf(today()); picked = null; render(); });
  // Add to Google Calendar: everything in one, or school days / classes / events as their own calendars
  // (the private links are made the first time)
  $('google-cal').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    let feeds = await api('GET', '/api/me/calendar');
    if (!feeds.url) feeds = await api('POST', '/api/me/calendar', {});
    const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': 'gc-title' },
      h('div', { class: 'dialog-head' }, h('h2', { id: 'gc-title' }, 'Add to your calendar'),
        h('button', { class: 'linklike', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')),
      h('p', { class: 'small muted' }, 'Pick everything as one calendar, or add each part as its own, with its own color, that you can turn on or off. Google opens in a new tab: click Add there. It checks for changes every few hours.'),
      calendarLinksEl(feeds),
      h('p', { class: 'small muted' }, 'Manage or turn off these links in ', h('a', { href: 'account.html#alerts' }, 'Profile → Notifications & calendar'), '.'));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }));

  try {
    [info, { items }] = await Promise.all([loadCalendar(), api('GET', '/api/me/calendar/items')]);
  } catch (err) {
    fill($('cal-grid'), h('p', { class: 'notice error' }, err.message));
    return;
  }
  month = monthOf(today());
  renderFilters();
  render();
})();
