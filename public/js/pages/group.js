// One group's page: about, links, join/leave, its events calendar, and (for leaders) requests,
// members, adding events and editing the group.
(async function () {
  renderNav('groups');
  const me = await requireLogin();
  const id = new URLSearchParams(location.search).get('id') || '';
  let g = null;
  let info = null;

  function renderHead() {
    document.title = `${g.name} · MHS Today`;
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

  // ---- board: posts, replies, polls (members and admins)
  const ago = (ms) => {
    const m = Math.floor((Date.now() - ms) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : new Date(ms).toLocaleDateString();
  };
  const multiline = (text) => text.split('\n').flatMap((line, i) => (i ? [h('br'), line] : [line]));
  function renderBoard(b) {
    fill($('posts'), b.posts.length ? b.posts.map((p) => h('div', { class: 'post' + (p.announcement ? ' announcement' : '') },
      h('div', { class: 'person' }, avatarEl(p.by, 30), h('div', null,
        h('strong', null, p.by.name), p.announcement ? [' ', h('span', { class: 'badge' }, 'Announcement')] : null,
        h('div', { class: 'small muted' }, ago(p.created)))),
      h('p', null, multiline(p.text)),
      p.replies.map((r) => h('div', { class: 'reply' },
        h('div', { class: 'small' }, h('strong', null, r.by.name), h('span', { class: 'muted' }, ` · ${ago(r.created)}`),
          r.canDelete ? [' · ', h('button', { class: 'linklike danger', type: 'button', onclick: (e) => boardAct(e, 'DELETE', `posts/${p.id}/replies/${r.id}`) }, 'Delete')] : null),
        h('div', { class: 'small' }, multiline(r.text)))),
      replyForm(p),
      p.canDelete ? h('button', { class: 'linklike danger small', type: 'button', onclick: (e) => { if (confirm('Delete this post and its replies?')) boardAct(e, 'DELETE', `posts/${p.id}`); } }, 'Delete post') : null))
      : h('p', { class: 'muted small' }, 'No posts yet. Say hi!'));
    $('polls-card').hidden = !b.polls.length && !g.canManage;
    fill($('polls'), b.polls.length ? b.polls.map((p) => {
      const total = p.counts.reduce((a, c) => a + c, 0);
      return h('div', { class: 'poll' },
        h('strong', null, p.question), p.closed ? h('span', { class: 'small muted' }, ' · closed') : null,
        p.options.map((o, i) => h('button', {
          class: 'poll-option' + (p.myVote === i ? ' mine' : ''), type: 'button', disabled: p.closed, 'aria-pressed': String(p.myVote === i),
          onclick: (e) => boardAct(e, 'POST', `polls/${p.id}/vote`, { choice: i })
        }, h('span', { class: 'poll-bar', style: { width: `${total ? Math.round((p.counts[i] / total) * 100) : 0}%` } }),
        h('span', { class: 'poll-label' }, o), h('span', { class: 'poll-count' }, String(p.counts[i])))),
        h('div', { class: 'small muted' }, `${total} vote${total === 1 ? '' : 's'}`, p.myVote === null || p.closed ? '' : ' · tap another choice to change your vote',
          p.canManage ? [' · ', h('button', { class: 'linklike', type: 'button', onclick: (e) => boardAct(e, 'PUT', `polls/${p.id}`, { closed: !p.closed }) }, p.closed ? 'Reopen' : 'Close'),
            ' · ', h('button', { class: 'linklike danger', type: 'button', onclick: (e) => { if (confirm('Delete this poll?')) boardAct(e, 'DELETE', `polls/${p.id}`); } }, 'Delete')] : null));
    }) : h('p', { class: 'muted small' }, 'No polls yet.'));
  }
  function replyForm(p) {
    const input = h('input', { type: 'text', maxlength: '1000', placeholder: 'Reply…', 'aria-label': `Reply to ${p.by.name}` });
    const form = h('form', { class: 'inline-field reply-form' }, input, h('button', { class: 'btn small secondary', type: 'submit' }, 'Reply'));
    form.addEventListener('submit', (e) => { e.preventDefault(); boardAct({ currentTarget: e.submitter }, 'POST', `posts/${p.id}/replies`, { text: input.value }); });
    return form;
  }
  const boardAct = (e, method, path, body) => busy(e.currentTarget, async () => renderBoard(await api(method, `/api/groups/${g.id}/${path}`, body)));
  async function loadBoard() {
    const member = g.myRole === 'leader' || g.myRole === 'member';
    $('board-card').hidden = !member && !me.admin;
    if ($('board-card').hidden) { $('polls-card').hidden = true; return; }
    $('announce-field').hidden = !g.canManage;
    $('poll-add').hidden = !g.canManage;
    renderBoard(await api('GET', `/api/groups/${g.id}/board`));
  }
  $('post-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      renderBoard(await api('POST', `/api/groups/${g.id}/posts`, { text: $('post-text').value, announcement: $('post-announce').checked }));
      e.target.reset();
      toast('Posted');
    });
  });
  $('poll-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const options = $('poll-options').value.split('\n').map((s) => s.trim()).filter(Boolean);
      renderBoard(await api('POST', `/api/groups/${g.id}/polls`, { question: $('poll-q').value, options }));
      e.target.reset();
      $('poll-add').open = false;
      toast('Poll started');
    });
  });

  async function loadEvents() {
    const events = await api('GET', `/api/events?group=${encodeURIComponent(g.id)}`);
    const today = schoolClock(info).date;
    const upcoming = events.filter((e) => eventEnd(e) >= today);
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
    await Promise.all([loadEvents(), loadBoard()]);
  }

  $('ev-signup').addEventListener('change', () => { $('ev-limit').disabled = !$('ev-signup').checked; });
  $('ev-limit').disabled = true;
  $('event-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api('POST', '/api/events', {
        title: $('ev-title').value, date: $('ev-date').value, time: $('ev-time').value, description: $('ev-description').value,
        endDate: $('ev-end-date').value || null, endTime: $('ev-end-time').value, location: $('ev-location').value,
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
