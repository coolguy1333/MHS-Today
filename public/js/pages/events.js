// Events: everything you can see (public, your groups', private ones you're invited to), and a form
// to add one: for everyone, for a group you lead, or privately for friends you invite.
(async function () {
  renderNav('events');
  await requireLogin();
  let events = [];
  let info = null;
  let me = null;

  function render() {
    const today = schoolClock(info).date;
    const upcoming = events.filter((e) => e.date >= today);
    const past = events.filter((e) => e.date < today).reverse();
    fill($('upcoming'), upcoming.length ? upcoming.map((e) => eventRow(e, today, load)) : h('p', { class: 'muted' }, 'No upcoming events yet.'));
    $('past-card').hidden = !past.length;
    fill($('past'), past.map((e) => eventRow(e, today, load)));
  }

  async function load() {
    try {
      [events, info] = await Promise.all([api('GET', '/api/events'), loadCalendar()]);
      render();
    } catch (e) {
      fill($('upcoming'), h('p', { class: 'notice error' }, e.message));
    }
  }

  // ---- the add form
  let led = []; // groups I lead
  function syncForm() {
    const vis = $('ev-visibility').value;
    const g = led.find((x) => x.id === $('ev-group').value);
    $('group-field').hidden = vis === 'private' || !led.length;
    $('invite-field').hidden = vis !== 'private';
    // "No group" only makes sense for public events by people who may post them
    $('ev-group').querySelector('option[value=""]').disabled = vis === 'group' || (vis === 'public' && !me.canPostEvents);
    if ($('ev-group').selectedOptions[0] && $('ev-group').selectedOptions[0].disabled) $('ev-group').value = (led[0] || {}).id || '';
    $('group-note').textContent = vis === 'public' && g && !g.approved ? 'This group is waiting for approval, so it can only post group-only events for now.' : '';
    $('limit-field').hidden = !$('ev-signup').checked;
  }

  async function setUpForm() {
    const [groups, friends] = await Promise.all([api('GET', '/api/groups'), api('GET', '/api/friends')]);
    led = groups.filter((g) => g.myRole === 'leader');
    const options = [
      me.canPostEvents || led.some((g) => g.approved) ? ['public', 'Everyone'] : null,
      led.length ? ['group', 'Members of a group I lead'] : null,
      ['private', 'Only friends I invite']
    ].filter(Boolean);
    fill($('ev-visibility'), options.map(([v, label]) => h('option', { value: v }, label)));
    fill($('ev-group'), h('option', { value: '' }, 'No group'), led.map((g) => h('option', { value: g.id }, g.name + (g.approved ? '' : ' (waiting for approval)'))));
    fill($('invite-list'), friends.friends.length
      ? friends.friends.map((f) => h('label', null, h('input', { type: 'checkbox', value: f.id }), avatarEl(f, 22), f.name))
      : h('p', { class: 'small muted' }, 'Add friends on the Friends page to invite them.'));
    if (!me.canPostEvents) {
      $('post-note').hidden = false;
      $('post-note').textContent = led.some((g) => g.approved)
        ? 'You can post events for everyone for the groups you lead. Other events for everyone come from admins and verified people.'
        : 'Events for everyone are posted by admins, verified people and leaders of approved groups. You can still make private events for your friends.';
    }
    for (const id of ['ev-visibility', 'ev-group', 'ev-signup']) $(id).addEventListener('change', syncForm);
    syncForm();
  }

  $('event-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const visibility = $('ev-visibility').value;
      const body = {
        title: $('title').value, date: $('date').value, time: $('time').value, description: $('description').value, visibility,
        groupId: visibility === 'private' ? null : $('ev-group').value || null,
        signup: $('ev-signup').checked ? { limit: $('ev-limit').value ? Number($('ev-limit').value) : 0 } : null
      };
      if (visibility === 'private') body.invitees = [...$('invite-list').querySelectorAll('input:checked')].map((c) => c.value);
      await api('POST', '/api/events', body);
      e.target.reset();
      $('date').value = schoolClock(info).date;
      syncForm();
      $('add-card').open = false;
      toast('Event added');
      await load();
    });
  });

  try {
    me = (await getMe()).user;
    $('add-card').hidden = false;
    await setUpForm();
  } catch (e) { /* the list below reports problems */ }
  await load();
  if (info) {
    const today = schoolClock(info).date;
    $('date').value = today;
    $('date').min = MHSCalendar.addDays(today, -7);
    $('date').max = MHSCalendar.addDays(today, 365 * 3);
  }
})();
