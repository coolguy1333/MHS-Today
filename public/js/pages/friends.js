// Friends: share a code, add by code (always confirmed first), accept requests, see where friends are.
(async function () {
  renderNav('friends');
  const user = await requireLogin();
  let myCode = user.friendCode;
  let data = { friends: [], incoming: [], outgoing: [] };
  let info = null;
  let lastKey = '';

  const pretty = (c) => `${c.slice(0, 5)}-${c.slice(5)}`;
  const inviteLink = () => `${location.origin}/friends.html?code=${myCode}`;
  const showCode = () => { $('my-code').textContent = pretty(myCode); };

  function render() {
    const live = liveState(info);
    const reqs = [
      ...data.incoming.map((r) => h('div', { class: 'list-row' },
        h('div', null, h('strong', null, r.name), ' wants to be friends'),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: (e) => act(e, () => api('POST', `/api/friends/${r.id}/accept`, {}), `You and ${r.name} are friends`) }, 'Accept'),
          h('button', { class: 'btn small secondary', type: 'button', onclick: (e) => act(e, () => api('DELETE', `/api/friends/${r.id}`), 'Request declined') }, 'Decline')))),
      ...data.outgoing.map((r) => h('div', { class: 'list-row' },
        h('div', null, 'Request sent to ', h('strong', null, r.name), h('div', { class: 'small muted' }, 'Waiting for them to accept')),
        h('button', { class: 'linklike danger', type: 'button', onclick: (e) => act(e, () => api('DELETE', `/api/friends/${r.id}`), 'Request cancelled') }, 'Cancel')))
    ];
    $('requests-card').hidden = !reqs.length;
    fill($('requests'), reqs);
    fill($('friends'), data.friends.length
      ? data.friends.map((f) => {
        const t = friendNowText(f, live);
        return h('div', { class: 'list-row' },
          h('div', null, h('strong', null, f.name), h('div', { class: 'small' + (t.muted ? ' muted' : '') }, t.text)),
          h('button', {
            class: 'linklike danger', type: 'button', 'aria-label': `Remove ${f.name}`,
            onclick: (e) => { if (confirm(`Remove ${f.name} from your friends?`)) act(e, () => api('DELETE', `/api/friends/${f.id}`), `${f.name} removed`); }
          }, 'Remove'));
      })
      : h('p', { class: 'muted' }, "No friends yet. Share your code, or enter a friend's code above."));
  }

  async function load(force) {
    const [d, i] = await Promise.all([api('GET', '/api/friends'), loadCalendar(true)]);
    const live = liveState(i);
    const key = JSON.stringify([d, live.status, live.cur && live.cur.period && live.cur.period.hour, live.day.dayLetter]);
    data = d; info = i;
    if (force || key !== lastKey) { lastKey = key; render(); } // skip identical refreshes so buttons keep keyboard focus
  }
  const act = (e, fn, message) => busy(e.currentTarget, async () => { await fn(); toast(message); await load(true); });

  // ---- my code
  showCode();
  $('copy-code').addEventListener('click', () => copyText(pretty(myCode)));
  $('copy-link').addEventListener('click', () => copyText(inviteLink()));
  $('new-code').addEventListener('click', (e) => {
    if (!confirm('Get a new code? Your old code and invite links will stop working. Current friends are not affected.')) return;
    busy(e.currentTarget, async () => { myCode = (await api('POST', '/api/me/friend-code', {})).friendCode; showCode(); toast('New code ready'); });
  });

  // ---- add by code: look up the name first, then confirm
  const box = $('confirm-box');
  const say = (kind, ...content) => { box.hidden = false; box.className = 'notice' + (kind === 'error' ? ' error' : ''); fill(box, content); };
  async function find(code, button) {
    await busy(button, async () => {
      try {
        const r = await api('POST', '/api/friends/lookup', { code });
        say('ok', h('p', null, 'Send a friend request to ', h('strong', null, r.name), '?'),
          h('div', { class: 'row' },
            h('button', {
              class: 'btn small', type: 'button',
              onclick: (e) => busy(e.currentTarget, async () => {
                const res = await api('POST', '/api/friends/request', { code });
                toast(res.status === 'friends' ? `You and ${res.name} are now friends` : `Request sent to ${res.name}`);
                $('friend-code').value = '';
                box.hidden = true;
                await load(true);
              })
            }, 'Send request'),
            h('button', { class: 'btn small secondary', type: 'button', onclick: () => { box.hidden = true; } }, 'Cancel')));
      } catch (e) {
        if (e.status === 404 || e.status === 400 || e.status === 429) say('error', e.message);
        else throw e;
      }
    });
  }
  $('find-form').addEventListener('submit', (e) => { e.preventDefault(); find($('friend-code').value, e.submitter); });

  try {
    info = await loadCalendar();
    await load(true);
  } catch (e) {
    fill($('friends'), h('p', { class: 'notice error' }, e.message));
  }

  // opened from an invite link: pre-fill and look the person up (the code is then removed from the address bar)
  const invite = new URLSearchParams(location.search).get('code');
  if (invite) {
    $('friend-code').value = invite;
    history.replaceState(null, '', 'friends.html');
    find(invite, null);
  }
  setInterval(() => load(false).catch(() => {}), 30000);
})();
