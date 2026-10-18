// My Schedule: one row per color block; the rotation grid shows where each block lands on Days A-D.
(async function () {
  renderNav('schedule');
  await requireLogin();

  const { BLOCKS, ROTATION, LUNCH_BLOCKS, LUNCH_NAMES, LUNCH_HOUR, LUNCHES, SCHEDULES, blockInfo, meetings, formatTime } = MHSBell;
  const DAYS = Object.keys(ROTATION);
  const HOURS = [1, 2, 3, 4, 5, 6];
  const panel = $('blocks');
  let dirty = false;

  let classes, info;
  try {
    [classes, info] = await Promise.all([api('GET', '/api/classes'), loadCalendar()]);
  } catch (e) {
    add(panel, h('p', { class: 'notice error' }, e.message));
    return;
  }
  const todayLetter = MHSCalendar.dayInfo(info.calendar, schoolClock(info).date).dayLetter;

  const input = (key, name) => panel.querySelector(`[data-block="${key}"][data-field="${name}"]`);
  const where = (key) => meetings(key).map((m) => `${m.letter}${m.hour}`).join(' · ');
  const lunchLabel = (l) => {
    const t = LUNCHES.daily[l];
    return `${l} Lunch (${formatTime(t.start)} – ${formatTime(t.end)})`;
  };

  function chip(b, text) {
    return h('span', { class: 'block-chip', style: { background: b.color, color: b.ink } }, text || b.label);
  }

  function setBlock(key, c) {
    input(key, 'name').value = c ? c.name : '';
    input(key, 'teacher').value = c ? c.teacher : '';
    input(key, 'room').value = c ? c.room : '';
    if (LUNCH_BLOCKS.includes(key)) input(key, 'lunch').value = (c && c.lunch) || '';
  }
  function readBlock(key) {
    const c = { name: input(key, 'name').value, teacher: input(key, 'teacher').value, room: input(key, 'room').value };
    if (LUNCH_BLOCKS.includes(key)) c.lunch = input(key, 'lunch').value;
    return c;
  }
  function setDirty(on) {
    dirty = on;
    $('save-state').textContent = on ? 'Unsaved changes' : '';
  }

  // ---- one row per block
  for (const b of BLOCKS) {
    const field = (name, label, attrs) => h('input', { 'data-block': b.key, 'data-field': name, 'aria-label': `${b.label} block ${label}`, type: 'text', ...attrs });
    const lunch = LUNCH_BLOCKS.includes(b.key)
      ? h('select', { 'data-block': b.key, 'data-field': 'lunch', 'aria-label': `${b.label} block lunch` },
        h('option', { value: '' }, 'Lunch?'), LUNCH_NAMES.map((l) => h('option', { value: l }, `${l} Lunch`)))
      : h('span');
    add(panel, h('div', { class: 'slot' },
      h('div', { class: 'slot-hour' }, chip(b), h('div', { class: 'small muted', title: 'Day and hour this block meets' }, where(b.key))),
      h('div', { class: 'name' }, field('name', 'class name', { placeholder: 'Class name', maxlength: '60' })),
      field('teacher', 'teacher', { placeholder: 'Teacher', maxlength: '60' }),
      field('room', 'room', { placeholder: 'Room', maxlength: '20' }),
      lunch));
    setBlock(b.key, classes[b.key]);
  }
  add($('lunch-help'),
    `Lunch is part of Hour ${LUNCH_HOUR}, so set it on the class you have then: `,
    LUNCH_BLOCKS.map((k, i) => [i ? ' and ' : '', chip(blockInfo(k)), ` (${meetings(k).filter((m) => m.hour === LUNCH_HOUR).map((m) => `Day ${m.letter}`).join(', ')})`]),
    '. On a regular day: ', LUNCH_NAMES.map(lunchLabel).join(', '), '.');

  // ---- the rotation grid, kept in sync with what's typed
  function renderGrid() {
    const head = h('tr', null, h('th', { scope: 'col' }, 'Hour'),
      DAYS.map((d) => h('th', { scope: 'col', class: d === todayLetter ? 'today' : null }, `Day ${d}`, d === todayLetter ? h('span', { class: 'sr-only' }, ' (today)') : null)));
    const rows = HOURS.map((hour) => {
      const p = SCHEDULES.daily.periods.find((x) => x.hour === hour);
      return h('tr', null,
        h('th', { scope: 'row' }, `Hour ${hour}`, h('div', { class: 'small muted' }, formatTime(p.start))),
        DAYS.map((d) => {
          const b = blockInfo(ROTATION[d][hour - 1]);
          const c = readBlock(b.key);
          const lunch = hour === LUNCH_HOUR && c.lunch ? ` · ${c.lunch} Lunch` : '';
          return h('td', { class: 'rot-cell' + (d === todayLetter ? ' today' : ''), style: { background: b.color, color: b.ink } },
            h('strong', null, c.name.trim() || b.label), c.name.trim() || lunch ? h('div', { class: 'small' }, (c.name.trim() ? b.label : '') + lunch) : null);
        }));
    });
    fill($('rotation'), h('thead', null, head), h('tbody', null, rows));
  }

  panel.addEventListener('input', () => { setDirty(true); renderGrid(); });

  // ---- fill in from Infinite Campus (read in the browser; nothing is sent until Save)
  let imported = null;
  $('ic-read').addEventListener('click', () => {
    const r = MHSImport.parse($('ic-text').value);
    imported = r.classes;
    const found = BLOCKS.filter((b) => imported[b.key]);
    $('ic-use').hidden = !found.length;
    fill($('ic-preview'), found.length
      ? [h('p', { class: 'small' }, `Found ${found.length} class${found.length === 1 ? '' : 'es'}:`),
        h('ul', { class: 'small' }, found.map((b) => {
          const c = imported[b.key];
          return h('li', null, chip(b), ' ', h('strong', null, c.name), [c.teacher, c.room ? `Rm ${c.room}` : '', c.lunch ? `${c.lunch} Lunch` : ''].filter(Boolean).map((x) => ` · ${x}`).join(''));
        })),
        r.warnings.map((w) => h('p', { class: 'notice small' }, w)),
        h('p', { class: 'small muted' }, 'Classes you already entered for other colors are kept. Check everything, then press Save.')]
      : h('p', { class: 'notice error small' }, "Couldn't find any classes. Copy the whole Schedule page (it has lines like \"Period Yellow\") and try again."));
  });
  $('ic-use').addEventListener('click', () => {
    if (!imported) return;
    for (const b of BLOCKS) if (imported[b.key]) setBlock(b.key, imported[b.key]);
    setDirty(true);
    renderGrid();
    $('import-card').open = false;
    $('ic-text').value = '';
    fill($('ic-preview'));
    $('ic-use').hidden = true;
    toast('Filled in. Check your classes, then press Save.');
    $('save-btn').focus();
  });
  $('schedule-form').addEventListener('submit', (e) => e.preventDefault());
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  $('clear-btn').addEventListener('click', () => {
    if (!confirm('Clear every class? (Nothing is saved until you press Save.)')) return;
    for (const b of BLOCKS) setBlock(b.key, null);
    setDirty(true);
    renderGrid();
  });

  $('save-btn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const out = {};
    for (const b of BLOCKS) {
      const c = readBlock(b.key);
      if (c.name.trim()) out[b.key] = c;
    }
    classes = await api('PUT', '/api/classes', out);
    for (const b of BLOCKS) setBlock(b.key, classes[b.key]); // show what the server kept
    setDirty(false);
    renderGrid();
    toast('Schedule saved');
  }));

  renderGrid();
})();
