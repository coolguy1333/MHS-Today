// Dashboard: today's day letter and schedule, a live "what's happening now" card, events, friends.
(function () {
  renderNav('dashboard');
  const { dayInfo, nextSchoolDay } = MHSCalendar;
  const { SCHEDULES, getCurrentPeriod, formatTime } = MHSBell;

  // viewDate: null = automatic (today, or the next school day when there's no school today)
  const S = { info: null, me: null, classes: {}, friends: [], events: [], viewDate: null, lastDate: null, key: '' };

  function model() {
    const cal = S.info.calendar;
    const now = schoolClock(S.info);
    const todayInfo = dayInfo(cal, now.date);
    const viewDate = S.viewDate || (todayInfo.schoolDay ? now.date : nextSchoolDay(cal, now.date));
    return { cal, now, todayInfo, viewDate, view: viewDate ? dayInfo(cal, viewDate) : null, isToday: viewDate === now.date };
  }

  const noSchoolText = (d) => (d.reason === 'weekend' ? 'Weekend' : 'No school') + (d.label ? ` – ${d.label}` : '');
  function listNames(names) {
    return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  }
  function go(date) {
    S.viewDate = date && date !== schoolClock(S.info).date ? date : null;
    renderAll();
  }

  function renderHead(m) {
    const head = clear($('day-head'));
    if (!m.view) { add(head, h('p', null, 'There are no school days on the calendar yet.')); return; }
    const v = m.view;
    const badge = v.schoolDay
      ? [v.dayLetter ? h('span', { class: 'badge blue' }, `Day ${v.dayLetter}`) : h('span', { class: 'badge muted' }, 'Day ?'), ' ' + (SCHEDULE_NAMES[v.scheduleType] || '')]
      : noSchoolText(v);
    const notes = [];
    if (!m.todayInfo.schoolDay && m.viewDate !== m.now.date) {
      notes.push(h('p', { class: 'notice' }, `${noSchoolText(m.todayInfo)} today. Showing the next school day.`));
    }
    if (v.schoolDay && !v.dayLetter) {
      notes.push(h('p', { class: 'notice' }, "The day letter hasn't been set yet, so classes can't be matched to today. ",
        S.me && S.me.admin ? h('a', { href: 'admin.html' }, 'Set it on the Admin page.') : 'An admin needs to set it.'));
    }
    const prev = nextSchoolDay(m.cal, m.viewDate, -1);
    const next = nextSchoolDay(m.cal, m.viewDate, 1);
    add(head, 
      h('h1', { class: 'day-title' }, fmtLongDay(m.viewDate)),
      h('p', { class: 'day-sub muted' }, badge),
      notes,
      h('div', { class: 'day-nav' },
        prev ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => go(prev) }, '← Previous school day') : null,
        S.viewDate ? h('button', { class: 'btn small', type: 'button', onclick: () => go(null) }, 'Back to today') : null,
        next ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => go(next) }, 'Next school day →') : null)
    );
  }

  function classCell(p, cls, m, hasAny) {
    if (p.hour === 'advisory') return h('span', { class: 'muted' }, 'Advisory');
    if (cls) {
      const key = `${m.view.dayLetter}_${p.hour}`;
      const buddies = S.friends.filter((f) => f.classes && sameClass(f.classes[key], cls)).map((f) => f.name);
      // line 1: the class; line 2: teacher and which friends are in it
      const meta = [cls.teacher || null, buddies.length ? h('span', { class: 'with' }, `With ${listNames(buddies)}`) : null].filter(Boolean);
      return [
        h('div', null, colorDot(cls.color), h('strong', null, cls.name), cls.room ? ` · Rm ${cls.room}` : null),
        meta.length ? h('div', { class: 'small muted' }, meta.flatMap((x, i) => (i ? [' · ', x] : [x]))) : null
      ];
    }
    if (S.me && hasAny && m.view.dayLetter) return h('span', { class: 'muted small' }, 'Not set. ', h('a', { href: 'schedule.html' }, 'Add it'));
    return null;
  }

  function renderTable(m) {
    const body = clear($('schedule-body'));
    const note = $('table-note');
    if (!m.view || !m.view.schoolDay) {
      note.hidden = true;
      add(body, h('tr', null, h('td', { colspan: 3, class: 'muted' }, m.view ? noSchoolText(m.view) : 'No school days found.')));
      return;
    }
    const hasAny = Object.keys(S.classes).length > 0;
    note.hidden = !(m.view.dayLetter && (!S.me || !hasAny));
    if (!note.hidden) {
      fill(note, S.me
        ? h('span', null, 'Add your classes on ', h('a', { href: 'schedule.html' }, 'My Schedule'), ' to see them here.')
        : h('span', null, h('a', { href: 'login.html' }, 'Sign in with Google'), ' to see your own classes here.'));
    }
    const schedule = SCHEDULES[m.view.scheduleType] || SCHEDULES.daily;
    for (const p of schedule.periods) {
      if (p.note) add(body, h('tr', { class: 'note-row' }, h('td', { colspan: 3 }, `${formatTime(p.note.start)} – ${formatTime(p.note.end)} · ${p.note.text}`)));
      const cls = m.view.dayLetter ? S.classes[`${m.view.dayLetter}_${p.hour}`] : null;
      add(body, h('tr', { class: 'period-row', dataset: { hour: String(p.hour) } },
        h('th', { scope: 'row' }, p.label),
        h('td', { class: 'time small muted' }, `${formatTime(p.start)} – ${formatTime(p.end)}`),
        h('td', { class: 'cls' }, classCell(p, cls, m, hasAny))));
    }
  }

  // The "now" card and the highlighted row. Runs every few seconds and never rebuilds anything focusable.
  function updateLive(m) {
    const card = $('status');
    document.querySelectorAll('#schedule-body tr.period-row').forEach((r) => { r.classList.remove('current'); r.removeAttribute('aria-current'); });
    if (!m.isToday || !m.view || !m.view.schoolDay) { card.hidden = true; return; }
    const v = m.view;
    const cur = getCurrentPeriod(v.scheduleType, m.now.minutes);
    const nameFor = (p) => {
      if (!p) return null;
      if (p.hour === 'advisory') return 'Advisory';
      const c = v.dayLetter && S.classes[`${v.dayLetter}_${p.hour}`];
      return c ? c.name + (c.room ? ` (Rm ${c.room})` : '') : null;
    };
    const periodText = (p) => `${p.label}${nameFor(p) ? ` – ${nameFor(p)}` : ''}`;
    let title, detail = null;
    if (cur.status === 'in-class') {
      title = `${cur.period.label} · ${fmtMinutes(cur.minutesLeft)} left`;
      const here = nameFor(cur.period);
      detail = [here, cur.next ? `Next: ${periodText(cur.next)} at ${formatTime(cur.next.start)}` : 'Last period of the day'].filter(Boolean).join(' · ');
    } else if (cur.status === 'passing') {
      title = `Passing period · ${cur.next.label} starts in ${fmtMinutes(cur.minutesUntil)}`;
      detail = `Next: ${periodText(cur.next)} at ${formatTime(cur.next.start)}`;
    } else if (cur.status === 'before-school') {
      title = `School starts at ${formatTime(cur.next.start)} (in ${fmtMinutes(cur.minutesUntil)})`;
      detail = `First up: ${periodText(cur.next)}`;
    } else {
      title = "School's out for today";
      detail = 'Use “Next school day” to see tomorrow.';
    }
    card.hidden = false;
    fill(card, h('div', { class: 'status-big' }, title), detail ? h('p', { class: 'muted' }, detail) : null);
    if (cur.status === 'in-class') {
      const row = document.querySelector(`#schedule-body tr.period-row[data-hour="${String(cur.period.hour)}"]`);
      if (row) { row.classList.add('current'); row.setAttribute('aria-current', 'time'); }
    }
  }

  function renderEvents(m) {
    const box = clear($('events-preview'));
    const upcoming = S.events.filter((e) => e.date >= m.now.date).slice(0, 5); // the server sends them in date order
    if (!upcoming.length) { add(box, h('p', { class: 'muted' }, 'Nothing coming up.')); return; }
    for (const e of upcoming) {
      add(box, h('div', { class: 'list-row' }, h('div', null,
        h('strong', null, e.title),
        h('div', { class: 'small muted' }, fmtRelativeDay(e.date, m.now.date) + (e.time ? ` · ${formatTime(e.time)}` : '')))));
    }
  }

  function renderFriends() {
    const box = clear($('friends-preview'));
    if (!S.me) { add(box, h('p', { class: 'muted small' }, h('a', { href: 'login.html' }, 'Sign in'), ' to see where your friends are.')); return; }
    if (!S.friends.length) { add(box, h('p', { class: 'muted small' }, 'No friends yet. ', h('a', { href: 'friends.html' }, 'Add some'), '.')); return; }
    const live = liveState(S.info);
    for (const f of S.friends) {
      const t = friendNowText(f, live);
      add(box, h('div', { class: 'list-row' }, h('strong', null, f.name), h('span', { class: 'small' + (t.muted ? ' muted' : '') }, t.text)));
    }
  }

  function renderAll() {
    const m = model();
    renderHead(m);
    renderTable(m);
    updateLive(m);
    renderEvents(m);
    renderFriends();
  }

  function tick() {
    if (!S.info) return;
    const m = model();
    if (m.now.date !== S.lastDate) { S.lastDate = m.now.date; renderAll(); return; } // a new day started
    updateLive(m);
    if (S.me && S.friends.length) renderFriends();
  }

  async function load() {
    try {
      const [info, me, events] = await Promise.all([loadCalendar(true), getMe(), api('GET', '/api/events')]);
      let classes = {}, friends = [];
      if (me.user) {
        const [c, f] = await Promise.all([api('GET', '/api/classes'), api('GET', '/api/friends')]);
        classes = c; friends = f.friends;
      }
      S.info = info; // always keep the newest clock offset
      const key = JSON.stringify([info.calendar, events, classes, friends, me.user && me.user.admin]);
      $('load-error').hidden = true;
      if (key === S.key) return; // nothing changed: leave the page (and keyboard focus) alone
      S.key = key;
      Object.assign(S, { me: me.user, classes, friends, events });
      S.lastDate = schoolClock(info).date;
      renderAll();
    } catch (e) {
      const box = clear($('load-error'));
      box.hidden = false;
      add(box, e.message + ' ', h('button', { class: 'linklike', type: 'button', style: { color: 'inherit' }, onclick: load }, 'Try again'));
    }
  }

  load();
  setInterval(tick, 15000);
  setInterval(load, 5 * 60000); // pick up new events, calendar changes and friends' changes
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); load(); } });
})();
