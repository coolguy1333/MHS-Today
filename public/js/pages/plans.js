// Lesson plans (teachers). Two ways to plan, same boxes underneath:
//   By week:  each school day of a week, with the classes that meet that day (from the day letter).
//   By class: one class, every day it meets over four weeks, to lay out a unit.
// Typing saves on its own; clearing a box removes that day's plan. Each class shows how many students
// see its plans, and how to fix it when students typed the class differently.
(async function () {
  renderNav('plans');
  const me = await requireLogin();
  if (!isTeacher(me)) { location.replace('index.html'); return; }
  const { addDays, dayInfo } = MHSCalendar;
  const { BLOCKS, ROTATION, blockInfo } = MHSBell;
  const VIEW_KEY = 'mhs-plan-view';
  const S = {
    info: null, classes: {}, reach: null, plans: {}, // plans: 'date|block' -> text
    view: 'week', block: null, start: null,
    boxes: new Map(), // 'date|block' -> the box on screen, so "Same for Hour 5" can fill it
    pending: new Set() // boxes with typing not saved yet
  };

  const today = () => schoolClock(S.info).date;
  const mondayOf = (d) => { const wd = utcDate(d).getUTCDay(); return addDays(d, wd === 0 ? 1 : wd === 6 ? 2 : 1 - wd); };
  const key = (d, b) => `${d}|${b}`;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // a prep or duty period: nothing for students to see, so no plan box
  const free = (name) => /\b(prep|planning|plan period|duty|office hours?)\b/i.test(name || '');
  const plannable = () => BLOCKS.filter((b) => S.classes[b.key] && !free(S.classes[b.key].name));
  const hourOf = (letter, block) => (ROTATION[letter] || []).indexOf(block) + 1; // 0 = doesn't meet
  // the teacher's classes that meet on a day letter, in hour order
  const meeting = (letter) => (ROTATION[letter] || []).map((b, i) => ({ block: b, hour: i + 1 })).filter((x) => S.classes[x.block]);
  const weeks = () => (S.view === 'class' ? 4 : 1);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // ---- saving
  async function savePlan(d, b, text) {
    await api('PUT', '/api/plans', { block: b, date: d, text });
    if (text.trim()) S.plans[key(d, b)] = text.trim(); else delete S.plans[key(d, b)];
  }
  // the latest plan for this class before `d` (for "Copy from last class")
  function lastPlan(d, b) {
    let best = null;
    for (const [k, text] of Object.entries(S.plans)) {
      const [date, block] = k.split('|');
      if (block === b && date < d && (!best || date > best.date)) best = { date, text };
    }
    return best;
  }
  // other sections of the same class meeting the same day ("Same for Hour 5")
  function twins(d, b) {
    const di = dayInfo(S.info.calendar, d);
    if (!di.schoolDay || !di.dayLetter) return [];
    return meeting(di.dayLetter).filter((x) => x.block !== b && norm(S.classes[x.block].name) === norm(S.classes[b].name));
  }

  // A box that saves itself a moment after you stop typing (and when you leave it), with the save
  // state and quick actions under it.
  function planBox(d, b, label) {
    const k = key(d, b);
    const box = h('textarea', { rows: '3', maxlength: '600', 'aria-label': `${label}: plan for ${fmtLongDay(d)}`, placeholder: "What's the class doing?", title: 'For example: Quiz on chapter 3, then start Unit 4' });
    box.value = S.plans[k] || '';
    const state = h('span', { class: 'plan-state small muted', 'aria-live': 'polite' });
    let timer = null, saved = box.value;
    const save = async () => {
      clearTimeout(timer);
      const text = box.value;
      if (text === saved) { S.pending.delete(k); return; }
      state.textContent = 'Saving…';
      try {
        await savePlan(d, b, text);
        saved = text;
        S.pending.delete(k);
        state.textContent = text.trim() ? 'Saved ✓' : 'Removed';
      } catch (e) {
        fill(state, h('span', { class: 'bad' }, `Not saved: ${e.message} `), h('button', { class: 'linklike', type: 'button', onclick: save }, 'Try again'));
      }
      actions();
    };
    const set = (text) => { box.value = text; S.pending.add(k); actions(); return save(); };
    const copyBtn = h('button', {
      class: 'linklike small', type: 'button',
      onclick: () => { const p = lastPlan(d, b); if (p) set(p.text); else toast('No earlier plan for this class yet'); }
    }, 'Copy from last class');
    const sameBtns = twins(d, b).map((x) => h('button', {
      class: 'linklike small', type: 'button', title: `Put this plan on Hour ${x.hour} too`,
      onclick: async (e) => {
        const text = box.value;
        const other = S.boxes.get(key(d, x.block));
        await busy(e.currentTarget, async () => {
          if (other) await other.set(text); else await savePlan(d, x.block, text);
          toast(`Hour ${x.hour} has the same plan`);
        });
      }
    }, `Same for Hour ${x.hour}`));
    // what makes sense right now: copy into an empty box; share a filled one
    function actions() {
      const empty = !box.value.trim();
      copyBtn.hidden = !empty || !lastPlan(d, b);
      for (const btn of sameBtns) btn.hidden = empty;
    }
    box.addEventListener('input', () => { state.textContent = ''; S.pending.add(k); actions(); clearTimeout(timer); timer = setTimeout(save, 800); });
    box.addEventListener('blur', save);
    actions();
    S.boxes.set(k, { set });
    return [box, h('div', { class: 'plan-foot' }, state, h('span', { class: 'plan-actions' }, copyBtn, sameBtns))];
  }

  // ---- who sees it
  function reachBadge(block) {
    const r = S.reach && S.reach.classes[block];
    if (!r) return null;
    const fix = !r.students || r.otherNames.length || r.noTeacher;
    return h('button', {
      class: 'reach-badge' + (r.students ? '' : ' none') + (fix ? ' fix' : ''), type: 'button',
      title: fix ? 'See who is missing and how to fix it' : 'Students who have this class on MHS Today',
      onclick: () => { S.block = block; if (S.view === 'class') render(); else { S.view = 'class'; go(S.start); } }
    }, r.students ? `${plural(r.students, 'student sees', 'students see')} it` : 'No students yet');
  }
  function reachPanel(block) {
    const r = S.reach && S.reach.classes[block];
    const c = S.classes[block], b = blockInfo(block);
    if (!r) return null;
    const lines = [];
    lines.push(h('p', null, r.students
      ? [h('strong', null, plural(r.students, 'student', 'students')), ` ${r.students === 1 ? 'has' : 'have'} ${c.name} (${b.label}) with you on MHS Today and ${r.students === 1 ? 'sees' : 'see'} these plans.`]
      : [h('strong', null, 'No students see these plans yet.'), ` They will when they add ${b.label}: "${c.name}" with teacher "${S.reach.lastName || 'your last name'}" on My classes.`]));
    for (const o of r.otherNames) {
      lines.push(h('p', { class: 'reach-fix' },
        `${plural(o.students, 'student', 'students')} with you in ${b.label} ${o.students === 1 ? 'calls' : 'call'} it "${o.name}". `,
        h('button', {
          class: 'btn small', type: 'button',
          onclick: (e) => {
            if (!confirm(`Rename your ${b.label} class from "${c.name}" to "${o.name}"? Your plans for it are kept.`)) return;
            busy(e.currentTarget, async () => {
              const res = await api('PUT', '/api/plans/class-name', { block, name: o.name });
              S.classes[block].name = res.name;
              S.reach = await api('GET', '/api/plans/reach');
              toast(`Renamed to "${res.name}"`);
              render();
            });
          }
        }, `Use "${o.name}"`)));
    }
    if (r.noTeacher) {
      lines.push(h('p', { class: 'small muted' }, `${plural(r.noTeacher, 'student has', 'students have')} ${c.name} in ${b.label} without a teacher. They'll see your plans once they add "${S.reach.lastName || 'your last name'}" as the teacher.`));
    }
    return h('div', { class: 'reach-panel' + (r.students ? '' : ' none') }, lines);
  }

  // ---- the two views
  function renderWeek(days) {
    const t = today();
    return h('div', { class: 'plan-week' }, days.map((d) => {
      const di = dayInfo(S.info.calendar, d);
      const head = h('div', { class: 'pd-head' }, h('strong', null, d === t ? `Today · ${fmtShortDay(d)}` : fmtShortDay(d)),
        h('span', { class: 'small muted' }, di.schoolDay ? (di.dayLetter ? `Day ${di.dayLetter}` : 'Day ?') : di.label || 'No school'));
      let body;
      if (!di.schoolDay) body = h('p', { class: 'small muted' }, 'No school.');
      else if (!di.dayLetter) body = h('p', { class: 'small muted' }, "The day letter isn't set yet.");
      else {
        const list = meeting(di.dayLetter);
        body = list.length ? list.map(({ block, hour }) => {
          const b = blockInfo(block);
          const label = `Hour ${hour} · ${S.classes[block].name}`;
          if (free(S.classes[block].name)) return h('div', { class: 'pd-class small muted' }, colorDot(b.color), label);
          return h('div', { class: 'pd-class' }, h('div', { class: 'pd-label' }, h('span', { class: 'small' }, colorDot(b.color), h('strong', null, label)), reachBadge(block)), planBox(d, block, label));
        }) : h('p', { class: 'small muted' }, 'None of your classes meet today.');
      }
      return h('section', { class: 'plan-day' + (d === t ? ' today' : '') + (di.schoolDay ? '' : ' off') }, head, body);
    }));
  }
  function renderClass(days) {
    const block = S.block, c = S.classes[block], b = blockInfo(block), t = today();
    const rows = [];
    for (const d of days) {
      const di = dayInfo(S.info.calendar, d);
      if (!di.schoolDay) {
        if (di.reason !== 'weekend') rows.push(h('div', { class: 'plan-row off small muted' }, h('span', { class: 'pr-date' }, fmtShortDay(d)), di.label || 'No school'));
        continue;
      }
      const hour = di.dayLetter ? hourOf(di.dayLetter, block) : 0;
      if (di.dayLetter && !hour) continue; // this class doesn't meet that day
      const when = di.dayLetter ? `Day ${di.dayLetter} · Hour ${hour}` : 'Day letter not set yet';
      rows.push(h('div', { class: 'plan-row' + (d === t ? ' today' : '') + (d < t ? ' past' : '') },
        h('div', { class: 'pr-date' }, h('strong', null, d === t ? 'Today' : fmtShortDay(d)), h('div', { class: 'small muted' }, d === t ? `${fmtShortDay(d)} · ${when}` : when)),
        di.dayLetter ? h('div', { class: 'pd-class' }, planBox(d, block, `${c.name} (${b.label})`)) : h('p', { class: 'small muted' }, 'Plans can be added once the day letter is set.')));
    }
    return [reachPanel(block), rows.length ? h('div', { class: 'plan-rows' }, rows) : h('p', { class: 'muted' }, `${c.name} doesn't meet in these weeks.`)];
  }

  function render() {
    S.boxes.clear();
    const mine = plannable();
    if (S.view === 'class' && !mine.some((b) => b.key === S.block)) S.block = mine.length ? mine[0].key : null;
    for (const [id, v] of [['tab-week', 'week'], ['tab-class', 'class']]) {
      $(id).setAttribute('aria-selected', String(S.view === v));
      $(id).classList.toggle('on', S.view === v);
    }
    const q = new URLSearchParams({ view: S.view, ...(S.view === 'class' && S.block ? { class: S.block } : {}) });
    history.replaceState(null, '', `plans.html?${q}`);
    try { localStorage.setItem(VIEW_KEY, q.toString()); } catch { /* storage blocked */ }

    const days = Array.from({ length: weeks() * 7 }, (_, i) => addDays(S.start, i)).filter((d) => { const wd = utcDate(d).getUTCDay(); return wd > 0 && wd < 6; });
    const short = (d) => fmtShortDay(d).replace(/^\w+, /, '');
    $('range-title').textContent = S.view === 'class' ? `${short(days[0])} – ${short(days[days.length - 1])}` : `Week of ${short(S.start)}`;
    $('range-prev').setAttribute('aria-label', S.view === 'class' ? 'Earlier weeks' : 'Previous week');
    $('range-next').setAttribute('aria-label', S.view === 'class' ? 'Later weeks' : 'Next week');

    const pick = $('class-pick');
    pick.hidden = S.view !== 'class' || !mine.length;
    fill(pick, mine.map((b) => h('button', {
      class: 'plan-class-btn' + (b.key === S.block ? ' on' : ''), type: 'button', 'aria-pressed': String(b.key === S.block),
      onclick: () => { S.block = b.key; render(); }
    }, colorDot(b.color), S.classes[b.key].name, h('span', { class: 'small muted' }, ` ${b.label}`))));

    if (!Object.keys(S.classes).length) {
      fill($('plans'), h('p', null, 'Add the classes you teach on ', h('a', { href: 'schedule.html' }, 'My classes'), ' first, then plan them here.'));
      return;
    }
    if (S.view === 'class' && !S.block) { fill($('plans'), h('p', { class: 'muted' }, 'All your classes are prep or duty periods.')); return; }
    fill($('plans'), S.view === 'class' ? renderClass(days) : renderWeek(days));
  }

  async function load() {
    const end = addDays(S.start, weeks() * 7 - 1);
    // four weeks before too, so "Copy from last class" can find the last plan
    const list = await api('GET', `/api/plans?from=${addDays(S.start, -28)}&to=${end}`);
    S.plans = {};
    for (const x of list) S.plans[key(x.date, x.block)] = x.text;
    render();
  }
  function go(start, jump) {
    if (S.pending.size && !confirm('Some plans are still saving. Leave them?')) return;
    S.pending.clear();
    S.start = start;
    fill($('plans'), h('p', { class: 'muted' }, 'Loading…'));
    load().then(() => {
      // on a phone the days are stacked: start at today's
      const t = document.querySelector('.plan-day.today, .plan-row.today');
      if (jump && t && window.matchMedia('(max-width: 1000px)').matches) t.scrollIntoView({ block: 'start' });
    }).catch((e) => fill($('plans'), h('p', { class: 'notice error' }, e.message)));
  }
  const step = (n) => go(addDays(S.start, n * 7 * weeks()));
  $('range-prev').addEventListener('click', () => step(-1));
  $('range-next').addEventListener('click', () => step(1));
  $('range-today').addEventListener('click', () => go(mondayOf(today()), true));
  $('tab-week').addEventListener('click', () => { if (S.view !== 'week') { S.view = 'week'; go(S.start); } });
  $('tab-class').addEventListener('click', () => { if (S.view !== 'class') { S.view = 'class'; go(S.start); } });
  window.addEventListener('beforeunload', (e) => { if (S.pending.size) { e.preventDefault(); e.returnValue = ''; } });

  try {
    [S.info, S.classes, S.reach] = await Promise.all([loadCalendar(), api('GET', '/api/classes'), api('GET', '/api/plans/reach').catch(() => null)]);
  } catch (e) { fill($('plans'), h('p', { class: 'notice error' }, e.message)); return; }
  // ?date= (from Today) opens that week; otherwise the view used last time
  let params = new URLSearchParams(location.search);
  const asked = params.get('date');
  if (!asked && !params.has('view')) { try { params = new URLSearchParams(localStorage.getItem(VIEW_KEY) || ''); } catch { /* storage blocked */ } }
  S.view = !asked && params.get('view') === 'class' ? 'class' : 'week';
  S.block = params.get('class');
  go(mondayOf(asked && MHSCalendar.parseDate(asked) !== null ? asked : today()), true);
})();
