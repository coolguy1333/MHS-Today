// Events board.
(async function () {
  renderNav('events');
  const { formatTime } = MHSBell;
  let events = [];
  let info = null;

  function row(e, today) {
    return h('div', { class: 'list-row' },
      h('div', null,
        h('strong', null, e.title),
        h('div', { class: 'small muted' }, fmtRelativeDay(e.date, today) + (e.time ? ` · ${formatTime(e.time)}` : '') + (e.by ? ` · added by ${e.by}` : '')),
        e.description ? h('div', { class: 'small' }, e.description) : null),
      e.mine ? h('button', {
        class: 'linklike danger', type: 'button', 'aria-label': `Delete ${e.title}`,
        onclick: (ev) => busy(ev.currentTarget, async () => {
          if (!confirm(`Delete "${e.title}"?`)) return;
          await api('DELETE', '/api/events/' + e.id);
          toast('Event deleted');
          await load();
        })
      }, 'Delete') : null);
  }

  function render() {
    const today = schoolClock(info).date;
    const upcoming = events.filter((e) => e.date >= today);
    const past = events.filter((e) => e.date < today).reverse();
    fill($('upcoming'), upcoming.length ? upcoming.map((e) => row(e, today)) : h('p', { class: 'muted' }, 'No upcoming events yet.'));
    $('past-card').hidden = !past.length;
    fill($('past'), past.map((e) => row(e, today)));
  }

  async function load() {
    try {
      [events, info] = await Promise.all([api('GET', '/api/events'), loadCalendar()]);
      render();
    } catch (e) {
      fill($('upcoming'), h('p', { class: 'notice error' }, e.message));
    }
  }

  $('event-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api('POST', '/api/events', {
        title: $('title').value, date: $('date').value, time: $('time').value, description: $('description').value
      });
      e.target.reset();
      $('date').value = schoolClock(info).date;
      toast('Event added');
      await load();
    });
  });

  try {
    const me = await getMe();
    const canPost = me.user && (me.config.eventPosting === 'everyone' || me.user.admin);
    $('add-card').hidden = !canPost;
    if (!me.user) $('signin-card').hidden = false;
    else if (!canPost) {
      $('signin-card').hidden = false;
      fill($('signin-card'), h('p', { class: 'muted' }, 'Only admins can add events right now.'));
    }
  } catch (e) { /* the list below reports problems */ }
  await load();
  if (info) {
    const today = schoolClock(info).date;
    $('date').value = today;
    $('date').min = MHSCalendar.addDays(today, -7);
    $('date').max = MHSCalendar.addDays(today, 365 * 3);
  }
})();
