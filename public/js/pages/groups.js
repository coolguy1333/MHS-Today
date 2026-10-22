// Groups directory: search, filter, join, and start a new group. Admins also see groups waiting for
// approval here, with an Approve button.
(async function () {
  renderNav('groups');
  const me = await requireLogin();
  let groups = [];

  const groupLink = (g) => `group.html?id=${encodeURIComponent(g.id)}`;
  function joinButton(g) {
    if (g.myRole === 'leader') return h('span', { class: 'badge' }, 'Leader');
    if (g.myRole === 'advisor') return h('span', { class: 'badge' }, 'Advisor');
    if (g.myRole === 'member') return h('span', { class: 'badge' }, 'Member');
    if (g.myRole === 'requested') return h('span', { class: 'small muted' }, 'Request sent');
    if (g.myRole === 'invited') { // a teacher invited to be the advisor
      return [
        h('button', { class: 'btn small', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { await api('POST', `/api/groups/${g.id}/advisor-invites/accept`, {}); toast(`You're the advisor of ${g.name}`); await load(); }) }, 'Be the advisor'),
        h('button', { class: 'btn small secondary', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { await api('DELETE', `/api/groups/${g.id}/advisor-invites/${me.id}`); toast('Invitation declined'); await load(); }) }, 'Decline')
      ];
    }
    if (isTeacher(me)) return null;
    if (!g.approved) return null;
    return h('button', {
      class: 'btn small', type: 'button',
      onclick: (e) => busy(e.currentTarget, async () => {
        const r = await api('POST', `/api/groups/${g.id}/join`, {});
        toast(r.myRole === 'member' ? `You joined ${g.name}` : `Request sent to ${g.name}'s leaders`);
        await load();
      })
    }, g.joinPolicy === 'open' ? 'Join' : 'Ask to join');
  }

  function render() {
    const q = $('q').value.trim().toLowerCase();
    const kind = $('kind').value;
    const shown = groups.filter((g) => (!kind || g.kind === kind) && (!$('mine').checked || ['leader', 'member', 'advisor'].includes(g.myRole))
      && (!q || `${g.name} ${g.description}`.toLowerCase().includes(q)));
    fill($('groups'), shown.length ? shown.map((g) => h('div', { class: 'group-card' },
      h('h3', null, h('a', { href: groupLink(g) }, g.name)),
      h('div', { class: 'small muted' }, `${GROUP_KINDS[g.kind]} · ${g.memberCount} member${g.memberCount === 1 ? '' : 's'}`,
        g.approved ? null : [' · ', h('span', { class: 'badge vis' }, 'Waiting for approval')]),
      g.myRole === 'invited' ? h('p', { class: 'small' }, h('span', { class: 'badge' }, 'Invitation'), ' Its leaders asked you to be the advisor.') : null,
      g.description ? h('p', { class: 'small' }, g.description.length > 160 ? `${g.description.slice(0, 157)}…` : g.description) : null,
      h('div', { class: 'row' }, joinButton(g),
        me.admin && !g.approved ? h('button', {
          class: 'btn small secondary', type: 'button',
          onclick: (e) => busy(e.currentTarget, async () => { await api('PUT', `/api/admin/groups/${g.id}`, { approved: true }); toast(`${g.name} approved`); await load(); })
        }, 'Approve') : null,
        h('a', { href: groupLink(g), class: 'small' }, 'Open →'))))
      : h('p', { class: 'muted' }, groups.length ? 'No groups match.'
        : isTeacher(me) ? 'No groups yet. When a club\'s student leaders invite you to be its advisor, the invitation shows up here.' : 'No groups yet. Start one below!'));
  }

  async function load() {
    try {
      groups = await api('GET', '/api/groups');
      // pending first for admins, then mine, then the rest
      const rank = (g) => (g.myRole === 'invited' || (me.admin && !g.approved) ? 0 : ['leader', 'member', 'advisor'].includes(g.myRole) ? 1 : 2);
      groups.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      render();
    } catch (e) {
      fill($('groups'), h('p', { class: 'notice error' }, e.message));
    }
  }

  for (const id of ['q', 'kind', 'mine']) $(id).addEventListener('input', render);
  $('create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const g = await api('POST', '/api/groups', {
        name: $('g-name').value, kind: $('g-kind').value, description: $('g-description').value, joinPolicy: $('g-join').value
      });
      location.href = groupLink(g);
    });
  });
  await load();
})();
