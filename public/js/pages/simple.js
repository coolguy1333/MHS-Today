// Simple mode (/simple): the clock, the block you're in and the time left, big. It has its own address
// so it can be bookmarked, kept on a classroom screen, or put on another website in an <iframe>.
//   ?next=1      also show what's next ("Next: Hour 3 – Chemistry at 10:05")
//   ?schedule=1  also show the day's bell schedule, with the current block marked
// Signed in, it uses your own classes and lunch (only you see them); anyone signed out, including most
// people seeing it on another site, gets the school's bell schedule.
(function () {
  const { dayInfo } = MHSCalendar;
  const { SCHEDULES, getCurrentPeriod, formatTime, LUNCH_HOUR, lunchFor, lunchTimes, atLunch } = MHSBell;
  const params = new URLSearchParams(location.search);
  const on = (k) => /^(1|true|yes|on)$/i.test(params.get(k) || '');
  const opts = { next: on('next'), schedule: on('schedule') };
  const framed = window.self !== window.top;
  const S = { info: null, classes: {}, timer: null, scheduleKey: '' };

  if (framed) {
    document.body.classList.add('framed');
    $('sm-home').target = '_blank'; // opening the full site from a box on another page: a new tab
    $('sm-home').rel = 'noopener';
  }

  const noSchoolText = (d) => (d.reason === 'weekend' ? 'Weekend' : 'No school') + (d.label ? ` – ${d.label}` : '');
  const countdown = (mins) => {
    const s = Math.max(0, Math.round(mins * 60)); // whole seconds (the clock has no fractions; this undoes float noise)
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  function periodName(day, p) {
    const c = classAt(S.classes, day.dayLetter, p.hour);
    if (MHSBell.outOfSchool(c)) return `${p.label} – out of school`;
    return c && !(p.hour === 'advisory' && c.name === 'Advisory') ? `${p.label} – ${c.name}` : p.label;
  }

  function state() {
    const now = schoolClock(S.info);
    const day = dayInfo(S.info.calendar, now.date);
    const out = { now, day, title: '', left: null, leftLabel: 'left', next: null, current: null };
    if (!day.schoolDay) { out.title = noSchoolText(day); return out; }
    const cur = getCurrentPeriod(day.scheduleType, now.minutes);
    const lunch = cur.status === 'in-class' && cur.period.hour === LUNCH_HOUR ? lunchFor(S.classes, day.dayLetter) : null;
    const eating = lunch && atLunch(day.scheduleType, lunch, now.minutes);
    if (eating) Object.assign(out, { title: `${lunch} Lunch`, left: eating.minutesLeft });
    else if (cur.status === 'in-class') Object.assign(out, { title: periodName(day, cur.period), left: cur.minutesLeft });
    else if (cur.status === 'passing') Object.assign(out, { title: 'Passing period', left: cur.minutesUntil, leftLabel: 'until the bell' });
    else if (cur.status === 'before-school') Object.assign(out, { title: 'Before school', left: cur.minutesUntil, leftLabel: 'until school starts' });
    else out.title = "School's out";
    if (cur.status === 'in-class') out.current = cur.period;
    const next = cur.next || null;
    if (next) out.next = `Next: ${periodName(day, next)} at ${formatTime(next.start)}`;
    else if (cur.status === 'in-class') out.next = 'Last block of the day';
    return out;
  }

  // The day's blocks; rebuilt only when the day (or your classes) change, then just re-marked.
  function paintSchedule(st) {
    const list = $('sm-schedule');
    list.hidden = !opts.schedule || !st.day.schoolDay;
    if (list.hidden) return;
    const key = JSON.stringify([st.now.date, st.day.scheduleType, st.day.dayLetter, S.classes]);
    if (key !== S.scheduleKey) {
      S.scheduleKey = key;
      const lunch = lunchFor(S.classes, st.day.dayLetter);
      const lt = lunch ? lunchTimes(st.day.scheduleType, lunch) : null;
      fill(list, (SCHEDULES[st.day.scheduleType] || SCHEDULES.daily).periods.map((p) => h('li', { dataset: { start: p.start, end: p.end } },
        h('span', { class: 'sm-s-time' }, `${formatTime(p.start)} – ${formatTime(p.end)}`),
        h('span', { class: 'sm-s-name' }, periodName(st.day, p),
          p.hour === LUNCH_HOUR && lt ? h('small', null, ` · ${lunch} Lunch ${formatTime(lt.start)}`) : null,
          p.note ? h('small', null, ` · ${p.note.text} until ${formatTime(p.note.end)}`) : null))));
    }
    const mins = Math.floor(st.now.minutes);
    for (const li of list.children) {
      const end = MHSBell.timeToMinutes(li.dataset.end);
      li.classList.toggle('now', !!st.current && li.dataset.start === st.current.start);
      li.classList.toggle('done', mins >= end);
    }
  }

  function paint() {
    const st = state();
    const [hm, ampm] = formatTime(MHSBell.minutesToTime(Math.floor(st.now.minutes))).split(' ');
    $('sm-hm').textContent = hm;
    $('sm-ampm').textContent = ampm;
    $('sm-date').textContent = `${fmtLongDay(st.now.date)}${st.day.dayLetter ? ` · Day ${st.day.dayLetter}` : ''}`;
    $('sm-title').textContent = st.title;
    $('sm-left').hidden = st.left === null;
    $('sm-left-num').textContent = st.left === null ? '' : countdown(st.left);
    $('sm-left-label').textContent = st.leftLabel;
    $('sm-next').hidden = !opts.next || !st.next;
    $('sm-next').textContent = st.next || '';
    paintSchedule(st);
  }
  // Tick just after each second starts on the (server-corrected) clock, so the countdown goes down
  // by exactly one every second: a plain 1-second timer drifts, then skips or repeats a number.
  function tick() {
    clearTimeout(S.timer);
    if (!document.hidden) paint();
    const ms = Date.now() + S.info.offset;
    S.timer = setTimeout(tick, 1000 - (ms % 1000) + 15);
  }

  // ---- options: what to show, and a link or embed code with those choices
  function link() {
    const u = new URL('/simple', location.origin);
    if (opts.next) u.searchParams.set('next', '1');
    if (opts.schedule) u.searchParams.set('schedule', '1');
    return u.href;
  }
  const embedCode = () => `<iframe src="${link()}" title="MHS Today bell schedule" width="100%" height="${opts.schedule ? 640 : 420}" style="border:0;border-radius:12px" loading="lazy"></iframe>`;
  function applyOptions() {
    document.body.classList.toggle('with-schedule', opts.schedule);
    history.replaceState(null, '', link().replace(location.origin, ''));
    if (S.info) paint();
  }
  $('opt-next').checked = opts.next;
  $('opt-schedule').checked = opts.schedule;
  $('opt-next').addEventListener('change', (e) => { opts.next = e.target.checked; applyOptions(); });
  $('opt-schedule').addEventListener('change', (e) => { opts.schedule = e.target.checked; applyOptions(); });
  $('copy-link').addEventListener('click', () => copyText(link()));
  $('copy-embed').addEventListener('click', () => copyText(embedCode()));
  $('sm-options-btn').addEventListener('click', (e) => {
    const box = $('sm-options');
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sm-options').hidden) $('sm-options-btn').click(); });

  const full = $('sm-full');
  full.hidden = !document.fullscreenEnabled;
  full.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}));
  document.addEventListener('fullscreenchange', () => { full.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });

  // keep the screen on while it's showing, where the browser allows it (asked again when coming back)
  function keepAwake() { // (not in a box on another site: that site would have to allow it)
    if (navigator.wakeLock && !framed && !document.hidden) navigator.wakeLock.request('screen').catch(() => {});
  }

  async function load() {
    try {
      const [info, me] = await Promise.all([loadCalendar(true), getMe().catch(() => ({ user: null }))]);
      const user = me.user;
      // your own classes when signed in (a box on another site usually isn't, so it shows the school's)
      const classes = user && !user.mustAgree ? await api('GET', '/api/classes').catch(() => ({})) : {};
      Object.assign(S, { info, classes });
      $('sm-hint').textContent = user
        ? 'Showing your classes (only you see them). Anyone not signed in sees the school bell schedule.'
        : 'Showing the school bell schedule. Sign in on MHS Today to see your own classes here.';
      $('sm-error').hidden = true;
      tick();
    } catch (e) {
      $('sm-error').hidden = false;
      $('sm-error').textContent = e.message;
      if (!S.info) setTimeout(load, 30000); // try again by itself: nobody may be at the screen
    }
  }

  applyOptions();
  load();
  keepAwake();
  setInterval(() => { if (!document.hidden) load(); }, 30 * 60000); // calendar changes, a new day's day letter
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { keepAwake(); if (S.info) tick(); } });
})();
