// My Schedule: one tab per rotation day, six hours each.
(async function () {
  renderNav('schedule');
  await requireLogin();

  const DAYS = ['A', 'B', 'C', 'D'];
  const HOURS = [1, 2, 3, 4, 5, 6];
  const DEFAULT_COLOR = '#4f7cff';
  const periods = MHSBell.SCHEDULES.daily.periods;
  const tabs = $('tabs');
  const panels = $('panels');
  let dirty = false;

  let classes, info;
  try {
    [classes, info] = await Promise.all([api('GET', '/api/classes'), loadCalendar()]);
  } catch (e) {
    add(panels, h('p', { class: 'notice error' }, e.message));
    return;
  }
  const todayLetter = MHSCalendar.dayInfo(info.calendar, schoolClock(info).date).dayLetter;

  const field = (day, hour, name, props) => h('input', { 'data-day': day, 'data-hour': hour, 'data-field': name, 'aria-label': `Day ${day} hour ${hour} ${props.label}`, ...props.attrs });
  const inputsFor = (day) => [...panels.querySelectorAll(`[data-day="${day}"]`)];
  const valueOf = (day, hour, name) => panels.querySelector(`[data-day="${day}"][data-hour="${hour}"][data-field="${name}"]`);

  function setSlot(day, hour, c) {
    valueOf(day, hour, 'name').value = c ? c.name : '';
    valueOf(day, hour, 'teacher').value = c ? c.teacher : '';
    valueOf(day, hour, 'room').value = c ? c.room : '';
    valueOf(day, hour, 'color').value = c ? c.color : DEFAULT_COLOR;
  }
  function readSlot(day, hour) {
    return {
      name: valueOf(day, hour, 'name').value, teacher: valueOf(day, hour, 'teacher').value,
      room: valueOf(day, hour, 'room').value, color: valueOf(day, hour, 'color').value
    };
  }
  function setDirty(on) {
    dirty = on;
    $('save-state').textContent = on ? 'Unsaved changes' : '';
  }

  // ---- build the tabs and panels
  for (const day of DAYS) {
    const tab = h('button', {
      class: 'tab', type: 'button', role: 'tab', id: `tab-${day}`, 'aria-controls': `panel-${day}`, 'aria-selected': 'false', tabindex: '-1',
      onclick: () => select(day)
    }, `Day ${day}`, day === todayLetter ? h('span', { class: 'sr-only' }, ' (today)') : null, day === todayLetter ? ' •' : null);
    add(tabs, tab);

    const panel = h('div', { role: 'tabpanel', id: `panel-${day}`, 'aria-labelledby': `tab-${day}`, hidden: true });
    if (day === todayLetter) add(panel, h('p', { class: 'small' }, h('span', { class: 'badge' }, 'Today is Day ' + day)));
    for (const hour of HOURS) {
      const p = periods.find((x) => x.hour === hour);
      add(panel, h('div', { class: 'slot' },
        h('div', { class: 'slot-hour' }, `Hour ${hour}`, h('div', { class: 'small muted' }, MHSBell.formatTime(p.start))),
        h('div', { class: 'name' }, field(day, hour, 'name', { label: 'class name', attrs: { type: 'text', placeholder: 'Class name', maxlength: '60' } })),
        field(day, hour, 'teacher', { label: 'teacher', attrs: { type: 'text', placeholder: 'Teacher', maxlength: '60' } }),
        field(day, hour, 'room', { label: 'room', attrs: { type: 'text', placeholder: 'Room', maxlength: '20' } }),
        field(day, hour, 'color', { label: 'colour', attrs: { type: 'color', value: DEFAULT_COLOR } })));
    }
    add(panels, panel);
    for (const hour of HOURS) setSlot(day, hour, classes[`${day}_${hour}`]);
  }

  const actions = $('day-actions');
  let current = null;
  function select(day) {
    current = day;
    for (const d of DAYS) {
      const on = d === day;
      const t = $(`tab-${d}`);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(`panel-${d}`).hidden = !on;
    }
    fill(actions, 
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => copyTo(day) }, `Copy Day ${day} to the other days`),
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => wipe(day) }, `Clear Day ${day}`));
  }
  tabs.addEventListener('keydown', (e) => {
    const i = DAYS.indexOf(current);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const day = DAYS[(i + step + DAYS.length) % DAYS.length];
    select(day);
    $(`tab-${day}`).focus();
  });

  function copyTo(from) {
    if (!confirm(`Replace the other days' classes with Day ${from}'s?`)) return;
    for (const hour of HOURS) {
      const c = readSlot(from, hour);
      for (const day of DAYS) if (day !== from) setSlot(day, hour, c.name.trim() ? c : null);
    }
    setDirty(true);
    toast("Copied. Don't forget to save.");
  }
  function wipe(day) {
    if (!confirm(`Clear everything on Day ${day}?`)) return;
    for (const hour of HOURS) setSlot(day, hour, null);
    setDirty(true);
  }

  panels.addEventListener('input', () => setDirty(true));
  $('schedule-form').addEventListener('submit', (e) => e.preventDefault());
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  $('save-btn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const out = {};
    for (const day of DAYS) for (const hour of HOURS) {
      const c = readSlot(day, hour);
      if (c.name.trim()) out[`${day}_${hour}`] = c;
    }
    classes = await api('PUT', '/api/classes', out);
    for (const day of DAYS) for (const hour of HOURS) setSlot(day, hour, classes[`${day}_${hour}`]); // show what the server kept
    setDirty(false);
    toast('Schedule saved');
  }));

  select(todayLetter || 'A');
})();
