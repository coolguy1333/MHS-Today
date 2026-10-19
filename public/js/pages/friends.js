// Friends: share a code, add by code (always confirmed first) or by name search, accept requests,
// see where friends are, choose what each friend can see of your schedule, and people you may know.
(async function () {
  renderNav('friends');
  const user = await requireLogin();
  let myCode = user.friendCode;
  let data = { friends: [], incoming: [], outgoing: [] };
  let myClasses = {};
  let info = null;
  let lastKey = '';

  const LEVELS = [['full', 'Classes + lunch'], ['lunch', 'Lunch only'], ['none', 'Nothing']];
  const pretty = (c) => `${c.slice(0, 5)}-${c.slice(5)}`;
  const inviteLink = () => `${location.origin}/friends.html?code=${myCode}`;
  const showCode = () => { $('my-code').textContent = pretty(myCode); };

  // Avatar + name (+ grade) for anyone; a friend's name opens their profile card.
  function person(p, ...more) {
    const name = p.bio !== undefined
      ? h('button', { class: 'linklike name-link', type: 'button', onclick: () => showProfileCard(p) }, p.name)
      : h('strong', null, p.name);
    return h('div', { class: 'person' }, avatarEl(p, 36),
      h('div', null, name, gradeText(p.grade) ? h('span', { class: 'small muted' }, ` · ${gradeText(p.grade)}`) : null, more));
  }

  function render() {
    const live = liveState(info);
    const reqs = [
      ...data.incoming.map((r) => h('div', { class: 'list-row' },
        person(r, h('div', { class: 'small muted' }, 'wants to be friends')),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: (e) => act(e, () => api('POST', `/api/friends/${r.id}/accept`, {}), `You and ${r.name} are friends`) }, 'Accept'),
          h('button', { class: 'btn small secondary', type: 'button', onclick: (e) => act(e, () => api('DELETE', `/api/friends/${r.id}`), 'Request declined') }, 'Decline')))),
      ...data.outgoing.map((r) => h('div', { class: 'list-row' },
        person(r, h('div', { class: 'small muted' }, 'Request sent. Waiting for them to accept')),
        h('button', { class: 'linklike danger', type: 'button', onclick: (e) => act(e, () => api('DELETE', `/api/friends/${r.id}`), 'Request cancelled') }, 'Cancel')))
    ];
    $('requests-card').hidden = !reqs.length;
    fill($('requests'), reqs);
    fill($('friends'), data.friends.length
      ? data.friends.map((f) => {
        const t = friendNowText(f, live);
        const lunch = live.day.schoolDay ? sharedLunchText(myClasses, f, live.day.dayLetter) : null;
        const level = h('select', { 'aria-label': `What ${f.name} can see of your schedule` },
          LEVELS.map(([v, label]) => h('option', { value: v, selected: f.myLevel === v }, label)));
        level.addEventListener('change', () => busy(level, async () => {
          try {
            await api('PUT', `/api/friends/${f.id}`, { level: level.value });
            f.myLevel = level.value;
            toast(`${f.name} can now see: ${LEVELS.find(([v]) => v === level.value)[1].toLowerCase()}`);
          } catch (err) { level.value = f.myLevel; throw err; }
        }));
        return h('div', { class: 'list-row friend-row' },
          person(f,
            f.pronouns ? h('span', { class: 'small muted' }, ` · ${f.pronouns}`) : null,
            h('div', { class: 'small' + (t.muted ? ' muted' : '') }, t.text),
            lunch ? h('div', { class: 'small' + (lunch.same ? '' : ' muted') }, `Today: ${lunch.text}`) : null),
          h('div', { class: 'friend-actions' },
            h('label', { class: 'small muted' }, 'They can see', level),
            h('button', {
              class: 'linklike danger', type: 'button', 'aria-label': `Remove ${f.name}`,
              onclick: (e) => { if (confirm(`Remove ${f.name} from your friends?`)) act(e, () => api('DELETE', `/api/friends/${f.id}`), `${f.name} removed`); }
            }, 'Remove')));
      })
      : h('p', { class: 'muted' }, "No friends yet. Search for someone's name, or share your code."));
  }

  // ---- people you may know
  async function loadSuggestions() {
    const { suggestions } = await api('GET', '/api/friends/suggestions');
    $('suggest-card').hidden = !suggestions.length;
    fill($('suggestions'), suggestions.map((s) => {
      const why = [
        s.mutual ? `${s.mutual} mutual friend${s.mutual === 1 ? '' : 's'}` : null,
        s.sharedClasses ? (s.sharedClasses === 1 ? 'In one of your classes' : `In ${s.sharedClasses} of your classes`) : null
      ].filter(Boolean).join(' · ');
      return h('div', { class: 'list-row' },
        person(s, h('div', { class: 'small muted' }, why)),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn small', type: 'button',
            onclick: (e) => act(e, async () => { await api('POST', '/api/friends/request', { id: s.id }); await loadSuggestions(); }, `Request sent to ${s.name}`)
          }, 'Add friend'),
          h('button', {
            class: 'linklike', type: 'button', 'aria-label': `Hide ${s.name} from suggestions`,
            onclick: (e) => busy(e.currentTarget, async () => { await api('POST', `/api/friends/suggestions/${s.id}/hide`, {}); await loadSuggestions(); })
          }, 'Hide')));
    }));
  }

  async function load(force) {
    const [d, i, c] = await Promise.all([api('GET', '/api/friends'), loadCalendar(true), api('GET', '/api/classes')]);
    const live = liveState(i);
    const lunchNow = live.status === 'in-class' && live.cur.period.hour === MHSBell.LUNCH_HOUR ? Math.floor(live.now.minutes) : null;
    const key = JSON.stringify([d, c, live.status, live.cur && live.cur.period && live.cur.period.hour, live.day.dayLetter, lunchNow]);
    data = d; info = i; myClasses = c;
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

  // ---- add by name
  let lastQuery = '';
  function resultRow(r) {
    const status = {
      friends: h('span', { class: 'small muted' }, 'Friends'),
      requested: h('span', { class: 'small muted' }, 'Request sent'),
      incoming: h('button', { class: 'btn small', type: 'button', onclick: (e) => act(e, async () => { await api('POST', `/api/friends/${r.id}/accept`, {}); await runSearch(lastQuery); }, `You and ${r.name} are friends`) }, 'Accept'),
      none: h('button', {
        class: 'btn small secondary', type: 'button',
        onclick: (e) => act(e, async () => { await api('POST', '/api/friends/request', { id: r.id }); await runSearch(lastQuery); }, `Request sent to ${r.name}`)
      }, 'Add friend')
    }[r.status || 'none'];
    return h('div', { class: 'list-row' }, person(r), status);
  }
  async function runSearch(q, button) {
    lastQuery = q;
    await busy(button, async () => {
      const box = $('search-results');
      try {
        const r = await api('POST', '/api/friends/search', { q });
        fill(box, r.results.length
          ? [r.results.map(resultRow), r.more ? h('p', { class: 'small muted' }, 'More people match. Add a last name to narrow it down.') : null]
          : h('p', { class: 'small muted' }, 'No one found. They may have turned off name search, so ask for their friend code.'));
      } catch (e) {
        if (e.status === 400 || e.status === 429) fill(box, h('p', { class: 'notice error' }, e.message));
        else throw e;
      }
    });
  }
  $('search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('search-q').value, e.submitter); });

  try {
    info = await loadCalendar();
    await load(true);
    loadSuggestions().catch(() => {});
  } catch (e) {
    fill($('friends'), h('p', { class: 'notice error' }, e.message));
  }

  // opened from an invite link: pre-fill and look the person up (the code is then removed from the address bar)
  const invite = new URLSearchParams(location.search).get('code');
  if (invite) {
    $('friend-code').value = invite;
    history.replaceState(null, '', 'friends.html');
    await find(invite, null);
    box.scrollIntoView({ block: 'center' }); // the add-a-friend card is below your friends
  }
  setInterval(() => load(false).catch(() => {}), 30000);
})();
