// One group's page: about, links, join/leave, its events calendar, and (for leaders) requests,
// members, adding events and editing the group.
(async function () {
  renderNav('groups');
  const me = await requireLogin();
  const id = new URLSearchParams(location.search).get('id') || '';
  let g = null;
  let info = null;

  function renderHead() {
    document.title = `${g.name} · MHS Hub`;
    const member = g.myRole === 'leader' || g.myRole === 'member';
    const action = member
      ? h('button', {
        class: 'btn small secondary', type: 'button',
        onclick: (e) => {
          if (!confirm(`Leave ${g.name}?`)) return;
          busy(e.currentTarget, async () => { await api('POST', `/api/groups/${g.id}/leave`, {}); toast(`You left ${g.name}`); await load(); });
        }
      }, 'Leave group')
      : g.myRole === 'requested'
        ? h('span', { class: 'small muted' }, 'Your request is waiting for a leader')
        : g.approved ? h('button', {
          class: 'btn small', type: 'button',
          onclick: (e) => busy(e.currentTarget, async () => {
            const r = await api('POST', `/api/groups/${g.id}/join`, {});
            toast(r.myRole === 'member' ? `You joined ${g.name}` : 'Request sent');
            await load();
          })
        }, g.joinPolicy === 'open' ? 'Join' : 'Ask to join') : null;
    fill($('head'),
      h('h1', { class: 'day-title' }, g.name),
      h('p', { class: 'muted' }, `${GROUP_KINDS[g.kind]} · ${g.memberCount} member${g.memberCount === 1 ? '' : 's'}`,
        g.myRole === 'leader' ? [' · ', h('span', { class: 'badge' }, 'You lead this group')] : null,
        g.approved ? null : [' · ', h('span', { class: 'badge vis' }, 'Waiting for an admin to approve it')]),
      g.description ? h('p', null, g.description) : null,
      g.links.length ? h('ul', { class: 'menu-items' }, g.links.map((l) => h('li', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.title)))) : null,
      h('div', { class: 'row' }, action,
        me.admin && !g.approved ? h('button', {
          class: 'btn small', type: 'button',
          onclick: (e) => busy(e.currentTarget, async () => { await api('PUT', `/api/admin/groups/${g.id}`, { approved: true }); toast('Group approved'); await load(); })
        }, 'Approve group') : null,
        me.admin && g.approved ? h('button', {
          class: 'linklike', type: 'button',
          onclick: (e) => busy(e.currentTarget, async () => { await api('PUT', `/api/admin/groups/${g.id}`, { approved: false }); toast('Group unlisted'); await load(); })
        }, 'Unlist') : null));
  }

  function renderPeople() {
    $('requests-card').hidden = !(g.requests && g.requests.length);
    fill($('requests'), (g.requests || []).map((p) => h('div', { class: 'list-row' },
      h('div', { class: 'person' }, avatarEl(p, 32), h('strong', null, p.name)),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: (e) => setRole(e, p, 'member', `${p.name} joined`) }, 'Accept'),
        h('button', { class: 'btn small secondary', type: 'button', onclick: (e) => setRole(e, p, null, 'Request declined') }, 'Decline')))));
    $('members-card').hidden = !g.members;
    fill($('members'), (g.members || []).map((p) => h('div', { class: 'list-row' },
      h('div', { class: 'person' }, avatarEl(p, 32), h('div', null, h('strong', null, p.name), p.role === 'leader' ? h('span', { class: 'small muted' }, ' · leader') : null)),
      g.canManage && p.id !== me.id ? h('div', { class: 'row nowrap' },
        h('button', { class: 'linklike', type: 'button', onclick: (e) => setRole(e, p, p.role === 'leader' ? 'member' : 'leader', p.role === 'leader' ? `${p.name} is no longer a leader` : `${p.name} is now a leader`) },
          p.role === 'leader' ? 'Remove leader' : 'Make leader'),
        h('button', { class: 'linklike danger', type: 'button', onclick: (e) => { if (confirm(`Remove ${p.name} from the group?`)) setRole(e, p, null, `${p.name} removed`); } }, 'Remove'))
        : null)));
  }
  const setRole = (e, p, role, message) => busy(e.currentTarget, async () => {
    await api('PUT', `/api/groups/${g.id}/members/${p.id}`, { role });
    toast(message);
    await load();
  });

  async function loadEvents() {
    const events = await api('GET', `/api/events?group=${encodeURIComponent(g.id)}`);
    const today = schoolClock(info).date;
    const upcoming = events.filter((e) => e.date >= today);
    fill($('events'), upcoming.length ? upcoming.map((e) => eventRow(e, today, loadEvents)) : h('p', { class: 'muted' }, 'No upcoming events.'));
  }

  function fillEditForm() {
    $('g-name').value = g.name;
    $('g-kind').value = g.kind;
    $('g-description').value = g.description;
    $('g-join').value = g.joinPolicy;
    $('g-links').value = g.links.map((l) => `${l.title} | ${l.url}`).join('\n');
  }

  async function load() {
    try {
      [g, info] = await Promise.all([api('GET', `/api/groups/${encodeURIComponent(id)}`), loadCalendar()]);
    } catch (e) {
      fill($('head'), h('p', { class: 'notice error' }, e.status === 404 ? "That group doesn't exist, or it hasn't been approved yet." : e.message));
      $('body').hidden = true;
      return;
    }
    $('body').hidden = false;
    renderHead();
    renderPeople();
    $('add-event').hidden = !g.canManage;
    $('edit-card').hidden = !g.canManage;
    $('ev-visibility').querySelector('option[value="public"]').disabled = !g.approved;
    if (g.canManage) fillEditForm();
    await loadEvents();
  }

  $('ev-signup').addEventListener('change', () => { $('ev-limit').disabled = !$('ev-signup').checked; });
  $('ev-limit').disabled = true;
  $('event-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api('POST', '/api/events', {
        title: $('ev-title').value, date: $('ev-date').value, time: $('ev-time').value, description: $('ev-description').value,
        visibility: $('ev-visibility').value, groupId: g.id,
        signup: $('ev-signup').checked ? { limit: $('ev-limit').value ? Number($('ev-limit').value) : 0 } : null
      });
      e.target.reset();
      $('ev-limit').disabled = true;
      toast('Event added');
      await loadEvents();
    });
  });
  $('edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const links = $('g-links').value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const i = line.lastIndexOf('|');
        return i < 0 ? { title: line, url: '' } : { title: line.slice(0, i).trim(), url: line.slice(i + 1).trim() };
      });
      await api('PUT', `/api/groups/${g.id}`, {
        name: $('g-name').value, kind: $('g-kind').value, description: $('g-description').value, joinPolicy: $('g-join').value, links
      });
      toast('Group saved');
      await load();
    });
  });
  $('delete-group').addEventListener('click', (e) => {
    if (!confirm(`Delete ${g.name}? Its events are deleted too. This can't be undone.`)) return;
    busy(e.currentTarget, async () => { await api('DELETE', `/api/groups/${g.id}`); location.href = 'groups.html'; });
  });

  await load();
  if (info) $('ev-date').value = schoolClock(info).date;
})();
