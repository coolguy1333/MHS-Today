// My classes (part of your profile): one row per color block plus Advisory; the rotation grid shows where each block lands on Days A-D.
(async function () {
  renderNav('account'); // My classes is part of your profile
  const me = await requireLogin();
  renderProfileHeader(me, 'classes');
  const teacher = isTeacher(me); // teachers: just the class names (no teacher or room), and no Infinite Campus import

  const { BLOCKS, ADVISORY, ROTATION, LUNCH_BLOCKS, LUNCH_NAMES, LUNCH_HOUR, LUNCHES, SCHEDULES, blockInfo, meetings, formatTime } = MHSBell;
  const DAYS = Object.keys(ROTATION);
  const KEYS = [...BLOCKS.map((b) => b.key), ADVISORY]; // everything saved
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
    if (!teacher) { input(key, 'teacher').value = c ? c.teacher : ''; input(key, 'room').value = c ? c.room : ''; }
    if (LUNCH_BLOCKS.includes(key)) input(key, 'lunch').value = (c && c.lunch) || '';
  }
  function readBlock(key) {
    const c = teacher ? { name: input(key, 'name').value } : { name: input(key, 'name').value, teacher: input(key, 'teacher').value, room: input(key, 'room').value };
    if (LUNCH_BLOCKS.includes(key)) c.lunch = input(key, 'lunch').value;
    return c;
  }
  function setDirty(on) {
    dirty = on;
    $('save-state').textContent = on ? 'Unsaved changes' : '';
    $('save-bar').classList.toggle('dirty', on); // keeps Save in view while there's something to save
  }

  // ---- column headings (wide screens; on phones each box keeps its placeholder), one row per block, then Advisory
  if (teacher) panel.classList.add('names-only');
  add(panel, h('div', { class: 'slot slot-head', 'aria-hidden': 'true' }, h('span', null, 'Block'), h('span', null, teacher ? 'Class you teach' : 'Class'),
    teacher ? null : [h('span', null, 'Teacher'), h('span', null, 'Room')], h('span', null, 'Lunch')));
  const ADV_ROW = { key: ADVISORY, label: 'Advisory' };
  for (const b of [...BLOCKS, ADV_ROW]) {
    const adv = b === ADV_ROW;
    const field = (name, label, attrs) => h('input', { 'data-block': b.key, 'data-field': name, 'aria-label': `${b.label}${adv ? '' : ' block'} ${label}`, type: 'text', ...attrs });
    const lunch = LUNCH_BLOCKS.includes(b.key)
      ? h('select', { 'data-block': b.key, 'data-field': 'lunch', 'aria-label': `${b.label} block lunch` },
        h('option', { value: '' }, 'Lunch?'), LUNCH_NAMES.map((l) => h('option', { value: l }, `${l} Lunch`)))
      : h('span');
    add(panel, h('div', { class: 'slot', id: adv ? 'advisory' : null },
      adv
        ? h('div', { class: 'slot-hour' }, h('span', { class: 'block-chip advisory-chip' }, 'Advisory'), h('div', { class: 'small muted' }, `Advisory days, ${formatTime(SCHEDULES.advisory.periods.find((p) => p.hour === ADVISORY).start)}`))
        : h('div', { class: 'slot-hour' }, chip(b), h('div', { class: 'small muted', title: 'Day and hour this block meets' }, where(b.key))),
      h('div', { class: 'name' }, field('name', adv ? 'name' : 'class name', { placeholder: adv ? 'Advisory (optional name)' : 'Class name', maxlength: '60' })),
      teacher ? null : field('teacher', 'teacher', { placeholder: 'Teacher', maxlength: '60' }),
      teacher ? null : field('room', 'room', { placeholder: 'Room', maxlength: '20' }),
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
    const found = [...BLOCKS, { key: ADVISORY, label: 'Advisory', color: 'var(--border)', ink: 'var(--text)' }].filter((b) => imported[b.key]);
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
    for (const k of KEYS) if (imported[k]) setBlock(k, imported[k]);
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
    for (const k of KEYS) setBlock(k, null);
    setDirty(true);
    renderGrid();
  });

  $('save-btn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const out = {};
    for (const k of KEYS) {
      const c = readBlock(k);
      if (c.name.trim() || (k === ADVISORY && ((c.teacher || '').trim() || (c.room || '').trim()))) out[k] = c; // (teachers have no teacher or room boxes)
    }
    classes = await api('PUT', '/api/classes', out);
    for (const k of KEYS) setBlock(k, classes[k]); // show what the server kept
    setDirty(false);
    renderGrid();
    toast('Schedule saved');
  }));

  renderGrid();
  // Nothing saved yet: the Infinite Campus import is the quickest start
  if (teacher) $('import-card').remove();
  else if (!Object.keys(classes).length) $('import-card').open = true;
})();
