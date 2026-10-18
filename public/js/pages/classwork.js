// Classwork: what classmates posted for your classes, and a form to post for one of them.
(async function () {
  renderNav('classwork');
  await requireLogin();
  const { blockInfo, BLOCKS } = MHSBell;
  let classes = {}, info = null, items = [], sessions = [];

  function row(i, today) {
    const b = blockInfo(i.block);
    return h('div', { class: 'list-row' + (i.hidden ? ' faded' : '') },
      h('div', null,
        h('span', { class: `badge kind-${i.kind}` }, KIND_NAMES[i.kind]), ' ', h('strong', null, i.title),
        h('div', { class: 'small' }, colorDot(b && b.color), i.className, i.teacher ? ` · ${i.teacher}` : '', ' · due ', fmtRelativeDay(i.due, today)),
        i.notes ? h('div', { class: 'small' }, i.notes) : null,
        h('div', { class: 'small muted' }, `Posted by ${i.by}`, i.hidden ? ' · hidden after reports, waiting for an admin' : '')),
      h('div', { class: 'row nowrap' },
        i.canDelete ? h('button', {
          class: 'linklike danger', type: 'button', 'aria-label': `Delete ${i.title}`,
          onclick: (e) => { if (confirm(`Delete "${i.title}"?`)) busy(e.currentTarget, async () => { await api('DELETE', `/api/classwork/${i.id}`); toast('Deleted'); await load(); }); }
        }, 'Delete') : null,
        i.kind !== 'assignment' && !i.hidden ? h('button', {
          class: 'linklike', type: 'button', 'aria-label': `Plan a study session for ${i.title}`,
          onclick: () => planFor(i)
        }, 'Study') : null,
        !i.mine ? h('button', {
          class: 'linklike', type: 'button', disabled: i.reported, 'aria-label': `Report ${i.title}`,
          onclick: (e) => {
            if (!confirm('Report this as wrong or inappropriate? After three reports it is hidden until an admin checks it.')) return;
            busy(e.currentTarget, async () => { await api('POST', `/api/classwork/${i.id}/report`, {}); toast('Reported. Thanks.'); await load(); });
          }
        }, i.reported ? 'Reported' : 'Report') : null));
  }

  function render() {
    const today = schoolClock(info).date;
    const upcoming = items.filter((i) => i.due >= today);
    const past = items.filter((i) => i.due < today).reverse();
    fill($('upcoming'), upcoming.length ? upcoming.map((i) => row(i, today)) : h('p', { class: 'muted' }, 'Nothing posted for your classes yet.'));
    $('past-card').hidden = !past.length;
    fill($('past'), past.map((i) => row(i, today)));
  }

  // ---- study sessions
  function sessionRow(s, today) {
    const b = blockInfo(s.block);
    return h('div', { class: 'list-row' },
      h('div', null,
        h('strong', null, s.title), s.classwork ? h('span', { class: 'small muted' }, ` · for ${KIND_NAMES[s.classwork.kind].toLowerCase()} "${s.classwork.title}"`) : null,
        h('div', { class: 'small' }, colorDot(b && b.color), s.className, ' · ', fmtRelativeDay(s.date, today),
          s.time ? ` · ${MHSBell.formatTime(s.time)}` : '', s.place ? ` · ${s.place}` : ''),
        s.notes ? h('div', { class: 'small' }, s.notes) : null,
        h('div', { class: 'small muted' }, `${s.going} going: ${s.people.join(', ')}`)),
      h('div', { class: 'row nowrap' },
        h('button', {
          class: 'btn small' + (s.me ? ' secondary' : ''), type: 'button',
          onclick: (e) => busy(e.currentTarget, async () => { await api('POST', `/api/study/${s.id}/going`, { on: !s.me }); await load(); })
        }, s.me ? 'Not going' : "I'm going"),
        s.canDelete ? h('button', {
          class: 'linklike danger', type: 'button', 'aria-label': `Delete ${s.title}`,
          onclick: (e) => { if (confirm(`Delete "${s.title}"?`)) busy(e.currentTarget, async () => { await api('DELETE', `/api/study/${s.id}`); await load(); }); }
        }, 'Delete') : null));
  }
  function fillFor() {
    const block = $('st-block').value;
    fill($('st-for'), h('option', { value: '' }, 'The class in general'),
      items.filter((i) => i.block === block && !i.hidden && i.due >= schoolClock(info).date)
        .map((i) => h('option', { value: i.id }, `${KIND_NAMES[i.kind]}: ${i.title}`)));
  }
  function planFor(i) {
    $('study-add').open = true;
    $('st-block').value = i.block;
    fillFor();
    $('st-for').value = i.id;
    $('st-title').value = `${i.title} review`;
    $('st-date').value = MHSCalendar.addDays(i.due, -1) >= schoolClock(info).date ? MHSCalendar.addDays(i.due, -1) : schoolClock(info).date;
    $('study-card').scrollIntoView({ behavior: 'smooth' });
    $('st-title').focus();
  }

  async function load() {
    try {
      [items, sessions] = await Promise.all([api('GET', '/api/classwork'), api('GET', '/api/study')]);
      render();
      const today = schoolClock(info).date;
      fill($('sessions'), sessions.length ? sessions.map((s) => sessionRow(s, today)) : h('p', { class: 'muted small' }, 'No study sessions planned yet.'));
    } catch (e) {
      fill($('upcoming'), h('p', { class: 'notice error' }, e.message));
    }
  }

  try {
    [classes, info] = await Promise.all([api('GET', '/api/classes'), loadCalendar()]);
  } catch (e) {
    fill($('upcoming'), h('p', { class: 'notice error' }, e.message));
    return;
  }
  const mine = BLOCKS.filter((b) => classes[b.key]);
  $('add-card').hidden = !mine.length;
  $('no-classes').hidden = !!mine.length;
  fill($('cw-block'), mine.map((b) => h('option', { value: b.key }, `${classes[b.key].name} (${b.label})`)));
  $('study-card').hidden = !mine.length;
  fill($('st-block'), mine.map((b) => h('option', { value: b.key }, `${classes[b.key].name} (${b.label})`)));
  $('st-block').addEventListener('change', fillFor);
  $('study-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api('POST', '/api/study', {
        block: $('st-block').value, classworkId: $('st-for').value || null, title: $('st-title').value, date: $('st-date').value,
        time: $('st-time').value, place: $('st-place').value, notes: $('st-notes').value
      });
      e.target.reset();
      $('study-add').open = false;
      toast('Study session planned. Classmates can see it now.');
      await load();
    });
  });
  const today = schoolClock(info).date;
  $('cw-due').min = today;
  $('cw-due').max = MHSCalendar.addDays(today, 180);
  $('cw-due').value = MHSCalendar.nextSchoolDay(info.calendar, today) || today;

  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api('POST', '/api/classwork', {
        block: $('cw-block').value, kind: $('cw-kind').value, title: $('cw-title').value, due: $('cw-due').value, notes: $('cw-notes').value
      });
      $('cw-title').value = ''; $('cw-notes').value = '';
      toast('Posted for your classmates');
      await load();
    });
  });
  await load();
  fillFor();
  $('st-date').min = today;
  $('st-date').value = today;
})();
