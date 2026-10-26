// Lesson plans (teachers): a week at a time, each school day lists the classes that meet then (from
// the day letter) with a box for what the class is doing. Typing saves on its own; clearing a box
// removes that day's plan. Students in the class see it on Today and their calendar.
(async function () {
  renderNav('plans');
  const me = await requireLogin();
  if (!isTeacher(me)) { location.replace('index.html'); return; }
  const { addDays, dayInfo } = MHSCalendar;
  const { BLOCKS, ROTATION } = MHSBell;
  let info, classes = {}, plans = {}, monday = null; // plans: 'date|block' -> text

  const today = () => schoolClock(info).date;
  const mondayOf = (d) => { const wd = utcDate(d).getUTCDay(); return addDays(d, wd === 0 ? 1 : wd === 6 ? 2 : 1 - wd); };
  const key = (d, b) => `${d}|${b}`;
  // a prep or duty period: nothing for students to see, so no plan box
  const free = (name) => /\b(prep|planning|plan period|duty|office hours?)\b/i.test(name || '');
  // the classes this teacher has that meet on a day letter, in hour order
  const meeting = (letter) => (ROTATION[letter] || []).map((b, i) => ({ block: b, hour: i + 1 })).filter((x) => classes[x.block]);

  async function load() {
    const [p] = await Promise.all([api('GET', `/api/plans?from=${monday}&to=${addDays(monday, 4)}`)]);
    plans = {};
    for (const x of p) plans[key(x.date, x.block)] = x.text;
    render();
  }

  // a box that saves itself a moment after you stop typing (and when you leave it)
  function planBox(d, b, label) {
    const box = h('textarea', { rows: '3', maxlength: '600', 'aria-label': `${label}: plan for ${fmtLongDay(d)}`, placeholder: 'What are you doing today?' });
    box.value = plans[key(d, b)] || '';
    const state = h('span', { class: 'plan-state small muted', 'aria-live': 'polite' });
    let timer = null, saved = box.value;
    const save = async () => {
      clearTimeout(timer);
      const text = box.value;
      if (text === saved) return;
      state.textContent = 'Saving…';
      try {
        await api('PUT', '/api/plans', { block: b, date: d, text });
        saved = text; plans[key(d, b)] = text.trim();
        state.textContent = text.trim() ? 'Saved' : 'Removed';
      } catch (e) { state.textContent = ''; showError(e); }
    };
    box.addEventListener('input', () => { state.textContent = ''; clearTimeout(timer); timer = setTimeout(save, 900); });
    box.addEventListener('blur', save);
    return [box, state];
  }

  function render() {
    const t = today();
    $('week-title').textContent = `Week of ${fmtShortDay(monday).replace(/^\w+, /, '')}`;
    const mine = BLOCKS.filter((b) => classes[b.key]);
    if (!mine.length) {
      fill($('week'), h('p', null, 'Add the classes you teach on ', h('a', { href: 'schedule.html' }, 'My classes'), ' first, then plan them here.'));
      return;
    }
    fill($('week'), [0, 1, 2, 3, 4].map((i) => {
      const d = addDays(monday, i);
      const di = dayInfo(info.calendar, d);
      const head = h('div', { class: 'pd-head' }, h('strong', null, fmtShortDay(d)),
        h('span', { class: 'small muted' }, di.schoolDay ? (di.dayLetter ? `Day ${di.dayLetter}` : 'Day ?') : di.label || 'No school'));
      let body;
      if (!di.schoolDay) body = h('p', { class: 'small muted' }, 'No school.');
      else if (!di.dayLetter) body = h('p', { class: 'small muted' }, "The day letter isn't set yet.");
      else {
        const list = meeting(di.dayLetter);
        body = list.length ? list.map(({ block, hour }) => {
          const b = MHSBell.blockInfo(block);
          const label = `Hour ${hour} · ${classes[block].name}`;
          if (free(classes[block].name)) return h('div', { class: 'pd-class small muted' }, colorDot(b.color), label);
          return h('div', { class: 'pd-class' }, h('div', { class: 'small' }, colorDot(b.color), h('strong', null, label)), planBox(d, block, label));
        }) : h('p', { class: 'small muted' }, 'None of your classes meet today.');
      }
      return h('section', { class: 'plan-day' + (d === t ? ' today' : '') + (di.schoolDay ? '' : ' off') }, head, body);
    }));
  }

  const go = (d, jump) => {
    monday = d;
    fill($('week'), h('p', { class: 'muted' }, 'Loading…'));
    load().then(() => {
      // on a phone the days are stacked: start at today's
      const t = document.querySelector('.plan-day.today');
      if (jump && t && window.matchMedia('(max-width: 1000px)').matches) t.scrollIntoView({ block: 'start' });
    }).catch((e) => fill($('week'), h('p', { class: 'notice error' }, e.message)));
  };
  $('week-prev').addEventListener('click', () => go(addDays(monday, -7)));
  $('week-next').addEventListener('click', () => go(addDays(monday, 7)));
  $('week-today').addEventListener('click', () => go(mondayOf(today())));
  try {
    [info, classes] = await Promise.all([loadCalendar(), api('GET', '/api/classes')]);
  } catch (e) { fill($('week'), h('p', { class: 'notice error' }, e.message)); return; }
  const asked = new URLSearchParams(location.search).get('date');
  go(mondayOf(MHSCalendar.parseDate(asked) !== null ? asked : today()), true);
})();
