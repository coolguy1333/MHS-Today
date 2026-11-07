// Simple mode (/simple): the clock, the block you're in and the time left, big. It has its own address
// so it can be bookmarked, kept on a classroom screen, or put on another website in an <iframe>.
// Everything you pick under Options is in the address, so a bookmark or embed code keeps it:
//   next=1       what's next ("Next: Hour 3 – Chemistry at 10:05")
//   schedule=1   the day's bell schedule, with the current block marked
//   date=0       no date and day letter          seconds=1   seconds on the clock
//   24h=1        a 24-hour clock                 minutes=1   time left as "51 min" instead of 50:27
//   theme=black|light   accent=blue|green|pink|plain   size=small|large   heading=Room 214 (60 characters)
// Opened with no options, it uses the ones you picked last on this device.
// Signed in, it uses your own classes and lunch (only you see them); anyone signed out, including most
// people seeing it on another site, gets the school's bell schedule.
(function () {
  const { dayInfo } = MHSCalendar;
  const { SCHEDULES, getCurrentPeriod, formatTime, LUNCH_HOUR, lunchFor, lunchTimes, atLunch } = MHSBell;
  const framed = window.self !== window.top;
  // option -> [address key, default, allowed values (a list), or 'bool' / 'text']
  const OPTIONS = {
    next: ['next', false, 'bool'], schedule: ['schedule', false, 'bool'], date: ['date', true, 'bool'],
    seconds: ['seconds', false, 'bool'], h24: ['24h', false, 'bool'], minutes: ['minutes', false, 'bool'],
    theme: ['theme', 'dark', ['dark', 'black', 'light']], accent: ['accent', 'gold', ['gold', 'blue', 'green', 'pink', 'plain']],
    size: ['size', 'normal', ['small', 'normal', 'large']], heading: ['heading', '', 'text']
  };
  const SAVED = 'mhs-simple';
  const defaults = () => Object.fromEntries(Object.entries(OPTIONS).map(([k, [, def]]) => [k, def]));
  function readOptions(params) {
    const o = defaults();
    for (const [k, [key, def, kind]] of Object.entries(OPTIONS)) {
      const v = params.get(key);
      if (v === null) continue;
      if (kind === 'bool') o[k] = /^(1|true|yes|on)$/i.test(v) ? true : /^(0|false|no|off)$/i.test(v) ? false : def;
      else if (kind === 'text') o[k] = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
      else o[k] = kind.includes(v.toLowerCase()) ? v.toLowerCase() : def;
    }
    return o;
  }
  // only what differs from the defaults goes in the address
  function toParams(o) {
    const q = new URLSearchParams();
    for (const [k, [key, def, kind]] of Object.entries(OPTIONS)) {
      if (o[k] === def) continue;
      q.set(key, kind === 'bool' ? (o[k] ? '1' : '0') : o[k]);
    }
    return q;
  }
  let params = new URLSearchParams(location.search);
  const known = Object.values(OPTIONS).some(([key]) => params.has(key));
  if (!known && !framed) { // a plain /simple (from Today): the choices made last time on this device
    try { params = new URLSearchParams(localStorage.getItem(SAVED) || ''); } catch { /* storage blocked */ }
  }
  let opts = readOptions(params);
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
  // "10:05 AM", or "10:05" / "14:30" on a 24-hour clock
  const fmtTime = (hhmm) => (opts.h24 ? hhmm.replace(/^0(?=\d:)/, '') : formatTime(hhmm));
  function leftText(mins) {
    if (!opts.minutes) return countdown(mins);
    const n = Math.max(1, Math.ceil(mins - 1e-6)); // "1 min" until the bell, never "0 min"
    return n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`;
  }
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
    if (next) out.next = `Next: ${periodName(day, next)} at ${fmtTime(next.start)}`;
    else if (cur.status === 'in-class') out.next = 'Last block of the day';
    return out;
  }

  // The day's blocks; rebuilt only when the day (or your classes) change, then just re-marked.
  function paintSchedule(st) {
    const list = $('sm-schedule');
    list.hidden = !opts.schedule || !st.day.schoolDay;
    if (list.hidden) return;
    const key = JSON.stringify([st.now.date, st.day.scheduleType, st.day.dayLetter, S.classes, opts.h24]);
    if (key !== S.scheduleKey) {
      S.scheduleKey = key;
      const lunch = lunchFor(S.classes, st.day.dayLetter);
      const lt = lunch ? lunchTimes(st.day.scheduleType, lunch) : null;
      fill(list, (SCHEDULES[st.day.scheduleType] || SCHEDULES.daily).periods.map((p) => h('li', { dataset: { start: p.start, end: p.end } },
        h('span', { class: 'sm-s-time' }, `${fmtTime(p.start)} – ${fmtTime(p.end)}`),
        h('span', { class: 'sm-s-name' }, periodName(st.day, p),
          p.hour === LUNCH_HOUR && lt ? h('small', null, ` · ${lunch} Lunch ${fmtTime(lt.start)}`) : null,
          p.note ? h('small', null, ` · ${p.note.text} until ${fmtTime(p.note.end)}`) : null))));
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
    const secs = Math.round(st.now.minutes * 60); // seconds since midnight (undoes float noise)
    const hhmm = MHSBell.minutesToTime(Math.floor(secs / 60));
    const [hm, ampm] = opts.h24 ? [fmtTime(hhmm), ''] : formatTime(hhmm).split(' ');
    $('sm-hm').textContent = opts.seconds ? `${hm}:${String(secs % 60).padStart(2, '0')}` : hm;
    $('sm-ampm').textContent = ampm;
    $('sm-date').hidden = !opts.date;
    $('sm-date').textContent = `${fmtLongDay(st.now.date)}${st.day.dayLetter ? ` · Day ${st.day.dayLetter}` : ''}`;
    $('sm-title').textContent = st.title;
    $('sm-left').hidden = st.left === null;
    $('sm-left-num').textContent = st.left === null ? '' : leftText(st.left);
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

  // ---- options: what to show and how it looks, and a link or embed code with those choices
  function link() {
    const q = toParams(opts).toString();
    return `${location.origin}/simple${q ? `?${q}` : ''}`;
  }
  const embedCode = () => `<iframe src="${link()}" title="MHS Today bell schedule" width="100%" height="${(opts.schedule ? 640 : 420) + (opts.heading ? 50 : 0)}" style="border:0;border-radius:12px" loading="lazy"></iframe>`;
  const FIELDS = ['next', 'schedule', 'date', 'seconds', 'h24', 'minutes', 'theme', 'accent', 'size', 'heading'];
  function showOptions() { // the controls match `opts`
    for (const k of FIELDS) {
      const el = $(`opt-${k}`);
      if (OPTIONS[k][2] === 'bool') el.checked = opts[k]; else el.value = opts[k];
    }
  }
  function applyOptions(save) {
    const b = document.body.classList;
    b.toggle('with-schedule', opts.schedule);
    b.toggle('sm-seconds', opts.seconds);
    for (const c of [...b]) if (/^sm-(theme|accent|size)-/.test(c)) b.remove(c);
    b.add(`sm-theme-${opts.theme}`, `sm-accent-${opts.accent}`, `sm-size-${opts.size}`);
    $('sm-heading').hidden = !opts.heading;
    $('sm-heading').textContent = opts.heading;
    document.querySelector('meta[name="theme-color"]').content = { dark: '#0b1636', black: '#000000', light: '#f4f6fb' }[opts.theme];
    document.title = opts.heading ? `${opts.heading} · MHS Today` : 'Simple mode · MHS Today';
    history.replaceState(null, '', link().slice(location.origin.length));
    if (save && !framed) try { localStorage.setItem(SAVED, toParams(opts).toString()); } catch { /* storage blocked */ }
    if (S.info) paint();
  }
  for (const k of FIELDS) {
    const el = $(`opt-${k}`);
    el.addEventListener(OPTIONS[k][2] === 'text' ? 'input' : 'change', () => {
      opts[k] = OPTIONS[k][2] === 'bool' ? el.checked : OPTIONS[k][2] === 'text' ? el.value.trim().slice(0, 60) : el.value;
      applyOptions(true);
    });
  }
  $('opt-reset').addEventListener('click', () => { opts = defaults(); showOptions(); applyOptions(true); });
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

  showOptions();
  applyOptions(false);
  load();
  keepAwake();
  setInterval(() => { if (!document.hidden) load(); }, 30 * 60000); // calendar changes, a new day's day letter
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { keepAwake(); if (S.info) tick(); } });
})();
