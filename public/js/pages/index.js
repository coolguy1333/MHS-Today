// Dashboard: today's day letter and schedule, a live "what's happening now" card, events, friends.
(function () {
  renderNav('dashboard');
  const { dayInfo, nextSchoolDay } = MHSCalendar;
  const { SCHEDULES, getCurrentPeriod, formatTime, blockFor, blockInfo, LUNCH_HOUR, lunchFor, lunchTimes, atLunch } = MHSBell;

  // viewDate: null = automatic (today, or the next school day when there's no school today)
  const S = { info: null, me: null, classes: {}, friends: [], events: [], tasks: null, classItems: [], notices: {}, viewDate: null, lastDate: null, key: '' };
  const KIND_LABEL = { test: 'Test', quiz: 'Quiz', assignment: 'Assignment', project: 'Project' };

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
      ? [v.dayLetter ? h('span', { class: 'badge blue' }, `Day ${v.dayLetter}`) : h('span', { class: 'badge muted' }, 'Day ?'), ' ' + scheduleTitle(v.scheduleType)]
      : noSchoolText(v);
    const notes = [];
    if (!m.todayInfo.schoolDay && m.viewDate !== m.now.date) {
      notes.push(h('p', { class: 'notice' }, `${noSchoolText(m.todayInfo)} today. Showing the next school day.`));
    }
    if (S.me && S.me.unreadFeedback) {
      notes.push(h('p', { class: 'notice' }, 'We answered your feedback. ', h('a', { href: 'feedback.html' }, 'See the reply')));
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
        prev ? h('button', { class: 'btn secondary small', type: 'button', 'aria-label': 'Previous school day', onclick: () => go(prev) }, '← Previous') : null,
        S.viewDate ? h('button', { class: 'btn small', type: 'button', onclick: () => go(null) }, 'Back to today') : null,
        next ? h('button', { class: 'btn secondary small', type: 'button', 'aria-label': 'Next school day', onclick: () => go(next) }, 'Next →') : null,
        h('button', { class: 'linklike small simple-open-btn', type: 'button', onclick: openSimple, title: 'Just the clock, time left and what is next' }, 'Simple mode'))
    );
  }

  // ---- Simple mode: the clock, the block you're in and the time left, big (a classroom screen, a
  // Chromebook on the desk). It sits over the Today page, which stays as it is.
  let simple = null; // { el, timer, wake }
  const countdown = (mins) => {
    const s = Math.max(0, Math.round(mins * 60)); // whole seconds (the clock has no fractions; this undoes float noise)
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  function simpleState() {
    const now = schoolClock(S.info);
    const day = dayInfo(S.info.calendar, now.date);
    const out = { now, day, title: '', left: null, leftLabel: 'left' };
    if (!day.schoolDay) { out.title = noSchoolText(day); return out; }
    const name = (p) => {
      const c = classAt(S.classes, day.dayLetter, p.hour);
      if (MHSBell.outOfSchool(c)) return `${p.label} – out of school`;
      return c && !(p.hour === 'advisory' && c.name === 'Advisory') ? `${p.label} – ${c.name}` : p.label;
    };
    const cur = getCurrentPeriod(day.scheduleType, now.minutes);
    const lunch = cur.status === 'in-class' && cur.period.hour === LUNCH_HOUR ? lunchFor(S.classes, day.dayLetter) : null;
    const eating = lunch && atLunch(day.scheduleType, lunch, now.minutes);
    if (eating) Object.assign(out, { title: `${lunch} Lunch`, left: eating.minutesLeft });
    else if (cur.status === 'in-class') Object.assign(out, { title: name(cur.period), left: cur.minutesLeft });
    else if (cur.status === 'passing') Object.assign(out, { title: 'Passing period', left: cur.minutesUntil, leftLabel: 'until the bell' });
    else if (cur.status === 'before-school') Object.assign(out, { title: 'Before school', left: cur.minutesUntil, leftLabel: 'until school starts' });
    else out.title = "School's out";
    return out;
  }
  function paintSimple() {
    const st = simpleState();
    const [hm, ampm] = formatTime(MHSBell.minutesToTime(Math.floor(st.now.minutes))).split(' ');
    const q = (c) => simple.el.querySelector(c);
    q('.sm-clock').firstChild.textContent = hm;
    q('.sm-ampm').textContent = ampm;
    q('.sm-date').textContent = `${fmtLongDay(st.now.date)}${st.day.dayLetter ? ` · Day ${st.day.dayLetter}` : ''}`;
    q('.sm-title').textContent = st.title;
    q('.sm-left').hidden = st.left === null;
    q('.sm-left strong').textContent = st.left === null ? '' : countdown(st.left);
    q('.sm-left span').textContent = st.leftLabel;
  }
  // Tick just after each second starts on the (server-corrected) clock, so the countdown goes down
  // by exactly one every second: a plain 1-second timer drifts, then skips or repeats a number.
  function tickSimple() {
    if (!simple) return;
    if (!document.hidden) paintSimple();
    const ms = Date.now() + S.info.offset;
    simple.timer = setTimeout(tickSimple, 1000 - (ms % 1000) + 15);
  }
  function openSimple() {
    if (simple || !S.info) return;
    const full = h('button', { class: 'sm-btn', type: 'button', hidden: !document.fullscreenEnabled }, 'Full screen');
    const el = h('div', { class: 'simple-mode', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Simple mode' },
      h('div', { class: 'sm-bar' }, full, h('button', { class: 'sm-btn', type: 'button', onclick: closeSimple }, 'Close')),
      h('div', { class: 'sm-date' }),
      h('div', { class: 'sm-clock', 'aria-live': 'off' }, '', h('span', { class: 'sm-ampm' })),
      h('div', { class: 'sm-title' }),
      h('div', { class: 'sm-left' }, h('strong', null), h('span', null)));
    full.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()).catch(() => {}));
    el.addEventListener('fullscreenchange', () => { full.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.fullscreenElement) closeSimple(); });
    document.body.append(el);
    document.body.classList.add('simple-open');
    simple = { el, timer: null, wake: null };
    tickSimple();
    el.querySelector('.sm-btn:not([hidden])').focus();
    // keep the screen on while it's showing, where the browser allows it
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then((w) => { if (simple) simple.wake = w; else w.release(); }).catch(() => {});
  }
  function closeSimple() {
    if (!simple) return;
    clearTimeout(simple.timer);
    if (simple.wake) simple.wake.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    simple.el.remove();
    simple = null;
    document.body.classList.remove('simple-open');
    const back = document.querySelector('.simple-open-btn');
    if (back) back.focus();
  }

  // Hour 4 also says which lunch you have and which friends share it.
  function lunchLine(m) {
    const lunch = lunchFor(S.classes, m.view.dayLetter);
    if (!lunch) return S.me ? h('div', { class: 'small muted' }, 'Lunch not set. ', h('a', { href: 'schedule.html' }, 'Pick A, B or C')) : null;
    const t = lunchTimes(m.view.scheduleType, lunch);
    return h('div', { class: 'small muted' }, `${lunch} Lunch ${formatTime(t.start)} – ${formatTime(t.end)}`);
  }

  // "Quiz today: Unit 3" under a class, for things due in it in the next few days (from the day shown)
  function dueLines(blockKey, m) {
    const last = MHSCalendar.addDays(m.viewDate, 3);
    return S.classItems.filter((i) => i.block === blockKey && i.due >= m.viewDate && i.due <= last)
      .map((i) => h('div', { class: 'due-line' }, h('span', { class: `badge kind-${i.kind}` }, KIND_LABEL[i.kind]), ` ${i.title} · ${fmtRelativeDay(i.due, m.now.date).replace(/^(Today|Tomorrow)$/, (w) => w.toLowerCase())}`));
  }
  // the teacher's lesson plan for this class on the day shown (students: their teacher's; teachers: their own)
  function planLine(blockKey, m) {
    const plan = (S.plans || []).find((x) => x.block === blockKey && x.date === m.viewDate);
    if (!plan) return isTeacher(S.me) && m.view && m.view.schoolDay ? h('div', { class: 'small' }, h('a', { href: `plans.html?date=${m.viewDate}` }, '+ Add a lesson plan')) : null;
    return h('div', { class: 'plan-line' }, h('strong', null, isTeacher(S.me) ? 'Your plan: ' : 'In class: '), plan.text,
      isTeacher(S.me) ? [' ', h('a', { class: 'small', href: `plans.html?date=${m.viewDate}` }, 'Edit')] : null);
  }
  function classCell(p, cls, m, hasAny) {
    if (p.hour === null) return p.info ? h('span', { class: 'muted small' }, p.info) : null; // not a class (a custom day's assembly…)
    if (p.hour === 'advisory') {
      if (!cls) return h('span', { class: 'muted' }, 'Advisory', S.me ? [' · ', h('a', { class: 'small', href: 'schedule.html#advisory' }, 'Add your advisory')] : null);
      const buddies = S.friends.filter((f) => f.classes && sameClass(f.classes.advisory, cls)).map((f) => f.name);
      return [
        h('div', null, h('strong', null, cls.name), cls.room ? ` · Rm ${cls.room}` : null),
        cls.teacher ? h('div', { class: 'small muted' }, cls.teacher) : null,
        buddies.length ? h('div', { class: 'with' }, `With ${listNames(buddies)}`) : null
      ];
    }
    const block = blockInfo(blockFor(m.view.dayLetter, p.hour));
    if (MHSBell.outOfSchool(cls)) return [h('div', null, colorDot(block.color), h('strong', null, 'Out of school')), h('div', { class: 'small muted' }, `${block.label} · ${cls.name}`)];
    if (cls) {
      const buddies = S.friends.filter((f) => f.classes && sameClass(f.classes[block.key], cls)).map((f) => f.name);
      // the class; then block and teacher; then which friends are in it
      return [
        h('div', null, colorDot(block.color), h('strong', null, cls.name), cls.room ? ` · Rm ${cls.room}` : null),
        h('div', { class: 'small muted' }, [block.label, cls.teacher].filter(Boolean).join(' · ')),
        buddies.length ? h('div', { class: 'with' }, `With ${listNames(buddies)}`) : null,
        planLine(block.key, m),
        dueLines(block.key, m),
        p.hour === LUNCH_HOUR ? lunchLine(m) : null
      ];
    }
    if (!block) return null;
    if (S.me && hasAny && !isTeacher(S.me)) return h('span', { class: 'muted small' }, colorDot(block.color), `${block.label}: not set. `, h('a', { href: 'schedule.html' }, 'Add it'));
    if (isTeacher(S.me) && hasAny) return h('span', { class: 'muted small' }, colorDot(block.color), `${block.label} · no class`); // a teacher's free block
    return h('span', { class: 'muted small' }, colorDot(block.color), block.label);
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
        ? h('span', null, 'Add your classes on ', h('a', { href: 'schedule.html' }, 'My classes'), ' to see them here.')
        : h('span', null, h('a', { href: 'login.html' }, 'Sign in with Google'), ' to see your own classes here.'));
    }
    const schedule = SCHEDULES[m.view.scheduleType] || SCHEDULES.daily;
    schedule.periods.forEach((p, i) => {
      const cls = classAt(S.classes, m.view.dayLetter, p.hour);
      add(body, h('tr', { class: 'period-row', dataset: { hour: String(p.hour), index: String(i) } },
        h('th', { scope: 'row' }, p.label),
        h('td', { class: 'time small muted' }, `${formatTime(p.start)} – ${formatTime(p.end)}`,
          p.note ? h('div', { class: 'period-note' }, `${p.note.text} until ${formatTime(p.note.end)}`) : null),
        h('td', { class: 'cls' }, classCell(p, cls, m, hasAny))));
    });
  }

  // "Get set up": the few things that make the site useful, until they're done (or hidden on this device).
  function renderSetup() {
    const card = $('setup-card');
    let hidden = false;
    try { hidden = localStorage.getItem('mhs-setup-hidden') === '1'; } catch { /* storage blocked */ }
    const steps = isTeacher(S.me) ? [
      { done: Object.keys(S.classes).length > 0, title: 'Add your classes', text: 'Type in the classes you teach, by color block.', href: 'schedule.html', go: 'Add classes' }
    ] : S.me ? [
      { done: Object.keys(S.classes).length > 0, title: 'Add your classes', text: 'Paste your schedule from Infinite Campus, or type it in.', href: 'schedule.html', go: 'Add classes' },
      S.tasks && S.tasks.available !== false
        ? { done: !!S.tasks.connected, title: 'Connect Google Tasks', text: 'See your assignments and what is due here.', href: 'classwork.html', go: 'Connect' } : null,
      { done: S.friends.length > 0, title: 'Add a friend', text: 'See where your friends are and who shares your lunch.', href: 'friends.html', go: 'Find friends' }
    ].filter(Boolean) : [];
    const left = steps.filter((s) => !s.done).length;
    card.hidden = hidden || !left;
    if (card.hidden) return;
    fill(card,
      h('div', { class: 'row between' }, h('h2', null, 'Get set up'), h('span', { class: 'small muted' }, `${steps.length - left} of ${steps.length} done`)),
      h('ol', { class: 'setup-steps' }, steps.map((s, i) => h('li', { class: s.done ? 'done' : null },
        h('span', { class: 'step-mark', 'aria-hidden': 'true' }, s.done ? '✓' : String(i + 1)),
        h('div', { class: 'step-text' }, h('strong', null, s.title), s.done ? h('span', { class: 'sr-only' }, ' (done)') : h('div', { class: 'small muted' }, s.text)),
        s.done ? null : h('a', { class: 'btn small', href: s.href }, s.go)))),
      h('p', { class: 'small muted' }, 'Reminders and calendar sync are in ', h('a', { href: 'account.html#alerts' }, 'Profile → Notifications & calendar'), '. ',
        h('button', {
          class: 'linklike', type: 'button',
          onclick: () => { try { localStorage.setItem('mhs-setup-hidden', '1'); } catch { /* storage blocked */ } card.hidden = true; }
        }, 'Hide this')));
  }

  // Two weeks at a glance, Monday to Friday: this week and next (next two on a weekend).
  // A school day opens its schedule above.
  const SHORT_TYPES = { advisory: 'Advisory', early_release: 'Early rel.' };
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  function renderWeeks(m) {
    const today = m.now.date;
    const wd = dayInfo(m.cal, today).weekday;
    const monday = MHSCalendar.addDays(today, wd === 0 ? 1 : wd === 6 ? 2 : 1 - wd);
    const cells = [];
    for (let i = 0; i < 14; i++) {
      if (i % 7 > 4) continue;
      const d = MHSCalendar.addDays(monday, i);
      const v = dayInfo(m.cal, d);
      const note = v.schoolDay ? (v.scheduleType === 'daily' ? '' : SHORT_TYPES[v.scheduleType] || MHSBell.scheduleName(v.scheduleType)) : v.label || 'No school';
      const cls = ['wk-day', v.schoolDay ? null : 'off', d < today ? 'past' : null, d === today ? 'today' : null, d === m.viewDate ? 'viewing' : null].filter(Boolean).join(' ');
      const body = [
        h('span', { class: 'wk-date' }, `${WEEKDAYS[i % 7]} ${Number(d.slice(5, 7))}/${Number(d.slice(8))}`),
        h('strong', { class: 'wk-letter' }, v.schoolDay ? v.dayLetter || '?' : '–'),
        h('span', { class: 'wk-note' }, note)
      ];
      cells.push(v.schoolDay
        ? h('button', {
          type: 'button', class: cls, 'aria-current': d === m.viewDate ? 'date' : null,
          'aria-label': `${fmtLongDay(d)}: Day ${v.dayLetter || 'unknown'}${note ? `, ${scheduleTitle(v.scheduleType)}` : ''}${d === today ? ' (today)' : ''}`,
          onclick: () => { go(d); $('day-head').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        }, body)
        : h('div', { class: cls }, body));
    }
    fill($('weeks'), cells);
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
      const c = classAt(S.classes, v.dayLetter, p.hour);
      if (MHSBell.outOfSchool(c)) return `out of school (${c.name})`;
      if (p.hour === 'advisory' && c) return c.name === 'Advisory' ? (c.room ? `Rm ${c.room}` : null) : c.name + (c.room ? ` (Rm ${c.room})` : '');
      return c ? c.name + (c.room ? ` (Rm ${c.room})` : '') : null;
    };
    const periodText = (p) => `${p.label}${nameFor(p) ? ` – ${nameFor(p)}` : ''}`;
    let title, detail = null;
    const lunch = cur.status === 'in-class' && cur.period.hour === LUNCH_HOUR ? lunchFor(S.classes, v.dayLetter) : null;
    const eating = lunch && atLunch(v.scheduleType, lunch, m.now.minutes);
    // Early Release / Late Arrival: out of school, back for the next real class
    const periods = (SCHEDULES[v.scheduleType] || SCHEDULES.daily).periods;
    const off = (p) => MHSBell.outOfSchool(classAt(S.classes, v.dayLetter, p.hour));
    const backFor = (from) => periods.slice(from).find((p) => !off(p)) || null;
    const offNow = cur.status === 'in-class' && off(cur.period);
    const lateStart = cur.status === 'before-school' && off(cur.next) ? backFor(periods.indexOf(cur.next)) : null;
    if (offNow) {
      const back = backFor(periods.indexOf(cur.period) + 1);
      title = `Out of school (${classAt(S.classes, v.dayLetter, cur.period.hour).name})`;
      detail = back ? `Back for ${periodText(back)} at ${formatTime(back.start)}` : 'Nothing else today';
    } else if (lateStart) {
      const mins = MHSBell.timeToMinutes(lateStart.start) - m.now.minutes;
      title = `Your day starts at ${formatTime(lateStart.start)} (in ${fmtMinutes(mins)})`;
      detail = `First up: ${periodText(lateStart)}`;
    } else if (eating) {
      title = `${lunch} Lunch · ${fmtMinutes(eating.minutesLeft)} left`;
      detail = eating.minutesLeft < cur.minutesLeft
        ? `Then back to ${periodText(cur.period)} until ${formatTime(cur.period.end)}`
        : cur.next ? `Next: ${periodText(cur.next)} at ${formatTime(cur.next.start)}` : null;
    } else if (cur.status === 'in-class') {
      title = `${cur.period.label} · ${fmtMinutes(cur.minutesLeft)} left`;
      const here = nameFor(cur.period);
      const n = cur.period.note;
      const inNote = n && m.now.minutes < MHSBell.timeToMinutes(n.end) ? `${n.text} until ${formatTime(n.end)}` : null;
      detail = [inNote, here, cur.next ? `Next: ${periodText(cur.next)} at ${formatTime(cur.next.start)}` : 'Last period of the day'].filter(Boolean).join(' · ');
    } else if (cur.status === 'passing') {
      title = `Passing period · ${cur.next.label} starts in ${fmtMinutes(cur.minutesUntil)}`;
      detail = `Next: ${periodText(cur.next)} at ${formatTime(cur.next.start)}`;
    } else if (cur.status === 'before-school') {
      title = `School starts at ${formatTime(cur.next.start)} (in ${fmtMinutes(cur.minutesUntil)})`;
      detail = `First up: ${periodText(cur.next)}`;
    } else {
      title = "School's out for today";
      detail = 'Use “Next →” to see the next school day.';
    }
    card.hidden = false;
    fill(card, h('div', { class: 'status-big' }, title), detail ? h('p', { class: 'muted' }, detail) : null);
    if (cur.status === 'in-class') {
      const i = (SCHEDULES[v.scheduleType] || SCHEDULES.daily).periods.indexOf(cur.period);
      const row = document.querySelector(`#schedule-body tr.period-row[data-index="${i}"]`);
      if (row) { row.classList.add('current'); row.setAttribute('aria-current', 'time'); }
    }
  }

  function renderEvents(m) {
    const box = clear($('events-preview'));
    const upcoming = S.events.filter((e) => eventEnd(e) >= m.now.date).slice(0, 5); // the server sends them in date order; multi-day ones stay until they end
    if (!upcoming.length) { add(box, h('p', { class: 'muted' }, 'Nothing coming up.')); return; }
    for (const e of upcoming) {
      add(box, h('div', { class: 'list-row' }, h('div', null,
        h('strong', null, e.title),
        h('div', { class: 'small muted' }, fmtEventWhen(e, m.now.date) + (e.location ? ` · ${e.location}` : '')))));
    }
  }

  // A short version of the day's menu: each counter and its first few dishes.
  async function renderLunchMenu(m) {
    const box = $('lunch-preview');
    const date = m.view && m.view.schoolDay ? m.viewDate : null;
    if (!date) { fill(box, h('p', { class: 'muted small' }, 'No school, no lunch.')); return; }
    if (S.menuDate === date) return;
    S.menuDate = date;
    try {
      const data = await api('GET', `/api/lunch?date=${date}`);
      if (S.menuDate !== date) return;
      if (!data.available) { fill(box, h('p', { class: 'muted small' }, data.error === 'not-configured' ? 'Lunch menu not set up.' : 'No menu posted.')); return; }
      fill(box, data.sections.slice(0, 4).map((s) => h('div', { class: 'list-row' }, h('div', null,
        s.title ? h('strong', null, s.title) : null,
        h('div', { class: 'small muted' }, s.items.filter((i) => i.kind === 'food').slice(0, 3).map((i) => i.name).join(', '))))));
    } catch (e) {
      S.menuDate = null;
      fill(box, h('p', { class: 'muted small' }, e.message));
    }
  }

  // Days until the dates admins picked (school days in brackets).
  function renderCountdowns(m) {
    const list = (S.notices.countdowns || []).filter((c) => c.date >= m.now.date);
    $('countdown-card').hidden = !list.length;
    fill($('countdowns'), list.map((c) => {
      const days = Math.round((MHSCalendar.parseDate(c.date) - MHSCalendar.parseDate(m.now.date)) / 86400000);
      let school = 0;
      for (let d = m.now.date; d < c.date && school < 400; d = MHSCalendar.addDays(d, 1)) if (MHSCalendar.dayInfo(m.cal, d).schoolDay) school++;
      return h('div', { class: 'countdown' },
        h('span', { class: 'big' }, days === 0 ? 'Today' : String(days)),
        h('span', null, days === 0 ? h('strong', null, c.title) : [`day${days === 1 ? '' : 's'} until `, h('strong', null, c.title)],
          days > 1 ? h('span', { class: 'small muted' }, ` (${school} school day${school === 1 ? '' : 's'})`) : null));
    }));
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

  // Due soon: overdue and the next week from the person's Google Tasks.
  // Due soon: classmates' tests and assignments for your classes, and your Google Tasks when they're on.
  function renderTasks(m) {
    const card = $('tasks-card');
    card.hidden = !S.me || isTeacher(S.me) || !Object.keys(S.classes).length;
    if (card.hidden) return;
    const t = m.now.date;
    const week = MHSCalendar.addDays(t, 7);
    const fromClass = S.classItems.filter((i) => i.due >= t && i.due <= week)
      .map((i) => ({ title: [h('span', { class: `badge kind-${i.kind}` }, KIND_LABEL[i.kind]), ' ', i.title], due: i.due, sub: i.className }));
    const tasksOn = S.tasks && S.tasks.available !== false && S.tasks.connected && !S.tasks.error;
    const mine = tasksOn ? S.tasks.tasks.filter((x) => x.due && x.due <= week).map((x) => ({ title: x.title, due: x.due, sub: 'My Google Tasks' })) : [];
    const soon = [...fromClass, ...mine].sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6);
    const connect = S.tasks && S.tasks.available !== false && !S.tasks.connected
      ? h('p', { class: 'muted small' }, h('a', { href: 'classwork.html' }, 'Connect Google Tasks'), ' to see your own to-do list here too.') : null;
    fill($('tasks-preview'), soon.length ? soon.map((x) => h('div', { class: 'list-row' }, h('div', null,
      h('strong', null, x.title),
      h('div', { class: 'small' + (x.due < t ? ' bad' : ' muted') }, x.due < t ? `Overdue · ${fmtRelativeDay(x.due, t)}` : fmtDue(x.due, t), ` · ${x.sub}`))))
      : h('p', { class: 'muted small' }, 'Nothing due in the next week. ', h('a', { href: 'classwork.html' }, 'Add a test or assignment'), ' when you hear about one.'), connect);
  }

  function renderAll() {
    const m = model();
    renderHead(m);
    renderSetup();
    renderTable(m);
    renderWeeks(m);
    updateLive(m);
    renderEvents(m);
    renderFriends();
    renderTasks(m);
    renderLunchMenu(m);
    renderCountdowns(m);
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
      const [info, me, events, notices] = await Promise.all([loadCalendar(true), getMe(), api('GET', '/api/events'), api('GET', '/api/notices')]);
      let classes = {}, friends = [], tasks = null, classItems = [], plans = [];
      const now = schoolClock(info).date;
      const planRange = `/api/plans?from=${MHSCalendar.addDays(now, -3)}&to=${MHSCalendar.addDays(now, 21)}`; // teachers' lesson plans
      if (isTeacher(me.user)) [classes, plans] = await Promise.all([api('GET', '/api/classes'), api('GET', planRange)]); // teachers: their own classes and plans; no friends, events or assignments
      else if (me.user) {
        // Google Tasks can be slow or unreachable; the rest of the page doesn't wait on it failing
        const [c, f, t, ci, pl] = await Promise.all([api('GET', '/api/classes'), api('GET', '/api/friends'),
          api('GET', '/api/tasks').catch((e) => (e.status === 409 ? { available: true, connected: false } : { connected: true, error: e.message, tasks: [] })),
          api('GET', '/api/classwork').catch(() => []), api('GET', planRange).catch(() => [])]);
        classes = c; friends = f.friends; tasks = t; classItems = ci; plans = pl;
      }
      S.info = info; // always keep the newest clock offset
      const key = JSON.stringify([info.calendar, events, classes, friends, tasks, classItems, plans, notices, me.user && me.user.admin]);
      $('load-error').hidden = true;
      if (key === S.key) return; // nothing changed: leave the page (and keyboard focus) alone
      S.key = key;
      Object.assign(S, { me: me.user, classes, friends, events: isTeacher(me.user) ? [] : events, tasks, classItems, plans, notices });
      document.body.classList.toggle('teacher', isTeacher(me.user));
      S.lastDate = schoolClock(info).date;
      renderAll();
    } catch (e) {
      const box = clear($('load-error'));
      box.hidden = false;
      add(box, e.message + ' ', h('button', { class: 'linklike', type: 'button', style: { color: 'inherit' }, onclick: load }, 'Try again'));
    }
  }

  load();
  // Nothing runs while the tab is hidden (Chromebooks keep many tabs open); coming back catches up.
  setInterval(() => { if (!document.hidden) tick(); }, 15000);
  setInterval(() => { if (!document.hidden) load(); }, 5 * 60000); // new events, calendar changes, friends' changes
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); load(); } });
})();
