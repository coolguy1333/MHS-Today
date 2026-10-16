// Classwork: what classmates posted for your classes, and a form to post for one of them.
(async function () {
  renderNav('classwork');
  await requireLogin();
  const { blockInfo, BLOCKS } = MHSBell;
  let classes = {}, info = null, items = [];

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

  async function load() {
    try {
      items = await api('GET', '/api/classwork');
      render();
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
})();
