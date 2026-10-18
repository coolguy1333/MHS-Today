// Admin: setup check, school calendar, people, backup/restore.
(async function () {
  renderNav('admin');
  const me = await requireLogin();
  const errBox = $('admin-error');
  if (!me.admin) {
    errBox.hidden = false;
    errBox.textContent = 'This page is for admins only.';
    return;
  }
  const { addDays, dayInfo, nextSchoolDay, emptyCalendar } = MHSCalendar;
  const TYPE_NAMES = { daily: 'Regular daily', advisory: 'Advisory day', early_release: 'Early release' };
  const POSTING_NAMES = { verified: 'admins and verified people', everyone: 'any signed-in student', admins: 'admins only' };
  const WEEKDAYS = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday']];
  let info, status, users;

  const today = () => schoolClock(info).date;
  const isWeekday = (d) => { const w = utcDate(d).getUTCDay(); return w >= 1 && w <= 5; };
  function fmtAgo(ms) {
    if (!ms) return 'never';
    const d = Math.floor((Date.now() - ms) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : new Date(ms).toLocaleDateString();
  }

  async function saveCalendar(next, message) {
    await api('PUT', '/api/admin/calendar', next);
    info = await loadCalendar(true);
    renderCalendar();
    renderSetup();
    if (message) toast(message);
  }

  // ---- setup check
  function renderSetup() {
    const cal = info.calendar;
    const MARKS = { ok: '\u2713', bad: '\u2717', warn: '!', info: 'i' };
    const LABELS = { ok: 'OK', bad: 'Problem', warn: 'Warning', info: 'Note' };
    const item = (level, ...content) => h('li', null, h('span', { class: `mark ${level}`, 'aria-label': LABELS[level] }, MARKS[level]), h('div', null, content));
    fill($('setup'),
      status.signIn
        ? item('ok', 'Google sign-in is configured.')
        : item('bad', 'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'),
      item('info', 'Google redirect URI to register: ', h('code', null, status.redirectUri), ' ',
        h('button', { class: 'linklike', type: 'button', onclick: () => copyText(status.redirectUri) }, 'Copy')),
      status.allowedDomains.length
        ? item('ok', 'Only these Google Workspace domains can sign in: ', h('strong', null, status.allowedDomains.join(', ')))
        : item('warn', 'Any Google account can sign in. Set ALLOWED_DOMAINS (for example your school\'s domain) to limit it.'),
      status.admins ? item('ok', `${status.admins} admin email${status.admins === 1 ? '' : 's'} configured.`) : item('bad', 'No admins: set ADMIN_EMAILS.'),
      cal.anchorDate ? item('ok', `Day letter rotation is set (anchored ${fmtShortDay(cal.anchorDate)}).`) : item('warn', 'The day letter has not been set. Use "Day letter" below.'),
      status.secureCookies ? item('ok', 'Cookies are HTTPS-only.') : item('warn', 'PUBLIC_URL is not https, so cookies are not marked Secure. Use https in production.'),
      status.lastSnapshot ? item('ok', `Latest automatic snapshot: ${status.lastSnapshot.replace(/^db-|\.json$/g, '')}.`) : item('warn', 'No automatic snapshot yet.'),
      item('info', `${status.users} ${status.users === 1 ? 'person' : 'people'}, ${status.events} event${status.events === 1 ? '' : 's'}. Event posting: ${POSTING_NAMES[status.eventPosting]}. School time zone: ${status.tz}.`));
  }

  // ---- calendar
  function groupNoSchool(noSchool) {
    const next = (d) => { let x = addDays(d, 1); while (!isWeekday(x)) x = addDays(x, 1); return x; };
    const groups = [];
    for (const d of Object.keys(noSchool).sort()) {
      const last = groups[groups.length - 1];
      if (last && last.label === noSchool[d] && next(last.to) === d) last.to = d;
      else groups.push({ from: d, to: d, label: noSchool[d] });
    }
    return groups;
  }
  function renderCalendar() {
    const cal = info.calendar;
    const t = today();
    // weekday pattern
    fill($('weekday-types'), WEEKDAYS.map(([k, name]) => {
      const sel = h('select', { 'aria-label': `${name} schedule` },
        Object.entries(TYPE_NAMES).map(([v, label]) => h('option', { value: v, selected: (cal.weekdayTypes[k] || 'daily') === v }, label)));
      sel.addEventListener('change', () => busy(sel, () => saveCalendar({ ...cal, weekdayTypes: { ...cal.weekdayTypes, [k]: sel.value } }, 'Saved')));
      return h('label', null, h('span', null, name), sel);
    }));
    // no-school list
    const groups = groupNoSchool(cal.noSchool);
    fill($('noschool-list'), groups.length ? groups.map((g) => h('div', { class: 'list-row' },
      h('div', null, h('strong', null, g.from === g.to ? fmtShortDay(g.from) : `${fmtShortDay(g.from)} – ${fmtShortDay(g.to)}`), g.label ? ` · ${g.label}` : ''),
      h('button', {
        class: 'linklike danger', type: 'button',
        onclick: (e) => busy(e.currentTarget, () => {
          const ns = { ...cal.noSchool };
          for (let d = g.from; d <= g.to; d = addDays(d, 1)) delete ns[d];
          return saveCalendar({ ...cal, noSchool: ns }, 'Removed');
        })
      }, 'Remove'))) : h('p', { class: 'muted small' }, 'None yet.'));
    // special schedules
    const specials = Object.keys(cal.types).sort();
    fill($('type-list'), specials.length ? specials.map((d) => h('div', { class: 'list-row' },
      h('div', null, h('strong', null, fmtShortDay(d)), ` · ${TYPE_NAMES[cal.types[d]]}`),
      h('button', {
        class: 'linklike danger', type: 'button',
        onclick: (e) => busy(e.currentTarget, () => { const ty = { ...cal.types }; delete ty[d]; return saveCalendar({ ...cal, types: ty }, 'Removed'); })
      }, 'Remove'))) : h('p', { class: 'muted small' }, 'None yet.'));
    // preview of the next school days
    const rows = [];
    let d = dayInfo(cal, t).schoolDay ? t : nextSchoolDay(cal, t);
    for (let i = 0; i < 12 && d; i++, d = nextSchoolDay(cal, d)) {
      const di = dayInfo(cal, d);
      rows.push(h('tr', null, h('td', null, fmtShortDay(d)), h('td', null, di.dayLetter ? `Day ${di.dayLetter}` : '?'), h('td', null, TYPE_NAMES[di.scheduleType])));
    }
    fill($('preview'), rows);
    if (!$('anchor-date').value) { $('anchor-date').value = t; }
  }

  $('anchor-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, () => saveCalendar({ ...info.calendar, anchorDate: $('anchor-date').value, anchorLetter: $('anchor-letter').value }, 'Day letter set'));
  });
  $('noschool-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const from = $('ns-from').value;
      const to = $('ns-to').value || from;
      if (to < from) throw new Error('"To" is before "From".');
      if (MHSCalendar.parseDate(to) - MHSCalendar.parseDate(from) > 120 * 86400000) throw new Error('That range is longer than 120 days.');
      const ns = { ...info.calendar.noSchool };
      for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekday(d)) ns[d] = $('ns-label').value.trim();
      await saveCalendar({ ...info.calendar, noSchool: ns }, 'Added');
      e.target.reset();
    });
  });
  $('type-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await saveCalendar({ ...info.calendar, types: { ...info.calendar.types, [$('ty-date').value]: $('ty-type').value } }, 'Added');
      e.target.reset();
    });
  });

  // ---- people
  async function reloadUsers() {
    [users, status] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/status')]);
    renderUsers();
    renderSetup();
  }
  let editing = null; // id of the person whose profile editor is open
  const badge = (on, text) => (on ? [' ', h('span', { class: 'badge' }, text)] : null);

  // Inline profile editor: name, pronouns, grade, bio, interests, lock, reset.
  function editorRow(u) {
    const name = h('input', { type: 'text', maxlength: '40', value: u.name, required: true });
    const pronouns = h('input', { type: 'text', maxlength: '20', value: u.pronouns || '' });
    const interests = h('input', { type: 'text', maxlength: '140', value: (u.interests || []).join(', ') });
    const grade = h('select', null, h('option', { value: '' }, 'Not set'), [9, 10, 11, 12].map((g) => h('option', { value: String(g), selected: u.grade === g }, `${g}th`)));
    const bio = h('textarea', { maxlength: '160', rows: '2' });
    bio.value = u.bio || '';
    const locked = h('input', { type: 'checkbox', checked: u.profileLocked });
    const save = (e, body, message) => busy(e.currentTarget, async () => {
      await api('PUT', `/api/admin/users/${u.id}`, body);
      editing = null;
      await reloadUsers();
      toast(message);
    });
    const form = h('form', { class: 'form-grid', 'aria-label': `Edit ${u.name}'s profile` },
      h('label', null, h('span', null, 'Display name'), name),
      h('label', null, h('span', null, 'Pronouns'), pronouns),
      h('label', null, h('span', null, 'Grade'), grade),
      h('label', { class: 'wide' }, h('span', null, 'Bio'), bio),
      h('label', { class: 'wide' }, h('span', null, 'Interests (comma-separated, up to 5)'), interests),
      h('label', { class: 'check wide' }, locked, h('span', null, "Lock profile (they can't change any of it, including their avatar)")),
      h('div', { class: 'wide row' },
        h('button', { class: 'btn small', type: 'submit' }, 'Save'),
        h('button', {
          class: 'btn small secondary', type: 'button',
          onclick: (e) => { if (confirm(`Reset ${u.name}'s profile to their Google first name and last initial, and clear their avatar, pronouns, grade, bio and interests?`)) save(e, { reset: true, profileLocked: locked.checked }, 'Profile reset'); }
        }, 'Reset profile'),
        h('button', { class: 'btn small secondary', type: 'button', onclick: () => { editing = null; renderUsers(); } }, 'Cancel')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const list = interests.value.split(',').map((s) => s.trim()).filter(Boolean);
      save({ currentTarget: e.submitter }, {
        name: name.value, pronouns: pronouns.value, grade: grade.value || null, bio: bio.value, interests: list, profileLocked: locked.checked
      }, 'Profile saved');
    });
    return h('tr', { class: 'editor-row' }, h('td', { colspan: 5 }, form));
  }

  function renderUsers() {
    fill($('users'), users.map((u) => [h('tr', null,
      h('td', null, h('div', { class: 'person' }, avatarEl(u, 32), h('div', null,
        u.name, badge(u.owner, 'owner'), badge(u.admin && !u.owner, 'admin'), badge(u.verified, 'verified'), badge(u.profileLocked, 'locked'),
        h('div', { class: 'small muted' }, [u.fullName, u.pronouns, u.grade ? `${u.grade}th grade` : null, u.searchable ? null : 'hidden from search'].filter(Boolean).join(' · ')),
        u.bio ? h('div', { class: 'small' }, u.bio) : null,
        u.interests && u.interests.length ? h('div', { class: 'small muted' }, `Interests: ${u.interests.join(', ')}`) : null))),
      h('td', { class: 'small' }, u.email),
      h('td', { class: 'small muted nowrap' }, fmtAgo(u.lastLogin)),
      h('td', null, u.admin ? h('span', { class: 'small muted' }, 'Admin') : h('button', {
        class: 'linklike', type: 'button', 'aria-label': `${u.verified ? 'Unverify' : 'Verify'} ${u.name}`,
        onclick: (e) => busy(e.currentTarget, async () => {
          await api('PUT', `/api/admin/users/${u.id}`, { verified: !u.verified });
          await reloadUsers();
          toast(u.verified ? `${u.name} can no longer post events` : `${u.name} can now post events`);
        })
      }, u.verified ? 'Unverify' : 'Verify')),
      h('td', { class: 'nowrap' },
        h('button', {
          class: 'linklike', type: 'button', 'aria-label': `Edit ${u.name}'s profile`, 'aria-expanded': String(editing === u.id),
          onclick: () => { editing = editing === u.id ? null : u.id; renderUsers(); }
        }, 'Edit'),
        u.owner || u.id === me.id ? null : [' · ', h('button', {
          class: 'linklike', type: 'button', 'aria-label': `${u.admin ? 'Remove admin from' : 'Make admin:'} ${u.name}`,
          onclick: (e) => {
            if (!confirm(u.admin ? `Remove ${u.name}'s admin access?` : `Make ${u.name} an admin? They will be able to manage people, events, links, the calendar and backups.`)) return;
            busy(e.currentTarget, async () => {
              await api('PUT', `/api/admin/users/${u.id}`, { admin: !u.admin });
              await reloadUsers();
              toast(u.admin ? `${u.name} is no longer an admin` : `${u.name} is now an admin`);
            });
          }
        }, u.admin ? 'Remove admin' : 'Make admin')],
        u.id === me.id || (u.owner && !me.owner) ? null : [' · ', h('button', {
          class: 'linklike danger', type: 'button', 'aria-label': `Remove ${u.name}`,
          onclick: (e) => {
            if (!confirm(`Remove ${u.name} (${u.email})? This deletes their account, classes and events.`)) return;
            busy(e.currentTarget, async () => { await api('DELETE', `/api/admin/users/${u.id}`); await reloadUsers(); toast('Removed'); });
          }
        }, 'Remove')])), editing === u.id ? editorRow(u) : null]));
  }

  // ---- editable lists (links, tools): rows of inputs, reorder, remove, add, save all at once
  const dirtyLists = new Set();
  function listEditor({ prefix, noun, fields, blank, path, key, pick }) {
    let items = [];
    const setDirty = (on) => { if (on) dirtyLists.add(prefix); else dirtyLists.delete(prefix); $(`${prefix}-state`).textContent = on ? 'Unsaved changes' : ''; };
    function render() {
      fill($(`${prefix}-editor`), items.map((item, i) => {
        const input = ([k, label, attrs]) => {
          const el = h('input', { type: k === 'url' ? 'url' : 'text', 'aria-label': `${noun} ${i + 1} ${label}`, placeholder: label, ...attrs });
          el.value = item[k] || '';
          el.addEventListener('input', () => { item[k] = el.value; setDirty(true); });
          return el;
        };
        const move = (d) => () => { const j = i + d; [items[i], items[j]] = [items[j], items[i]]; setDirty(true); render(); };
        const [main, desc] = [fields.slice(0, -1), fields[fields.length - 1]];
        return h('div', { class: 'link-edit' }, main.map(input),
          h('div', { class: 'row nowrap' },
            h('button', { class: 'linklike', type: 'button', 'aria-label': `Move ${noun} ${i + 1} up`, onclick: move(-1), disabled: i === 0 }, '↑'),
            h('button', { class: 'linklike', type: 'button', 'aria-label': `Move ${noun} ${i + 1} down`, onclick: move(1), disabled: i === items.length - 1 }, '↓'),
            h('button', { class: 'linklike danger', type: 'button', 'aria-label': `Remove ${noun} ${i + 1}`, onclick: () => { items.splice(i, 1); setDirty(true); render(); } }, 'Remove')),
          h('div', { class: 'desc' }, input(desc)));
      }));
    }
    $(`${prefix}-add`).addEventListener('click', () => {
      items.push(blank(items));
      setDirty(true);
      render();
      const first = $(`${prefix}-editor`).querySelector('.link-edit:last-child input');
      if (first) first.focus();
    });
    $(`${prefix}-save`).addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const saved = await api('PUT', path, { [key]: items });
      items = pick ? saved[key] : saved;
      setDirty(false);
      render();
      toast('Saved');
    }));
    return { set(list) { items = list; render(); } };
  }
  window.addEventListener('beforeunload', (e) => { if (dirtyLists.size) { e.preventDefault(); e.returnValue = ''; } });
  const linksEditor = listEditor({
    prefix: 'links', noun: 'Link', path: '/api/admin/links', key: 'links',
    fields: [['title', 'Title', { maxlength: '80' }], ['url', 'https://…', { maxlength: '500' }], ['category', 'Category', { maxlength: '40' }],
      ['description', 'Short description (optional)', { maxlength: '160' }]],
    blank: (list) => ({ title: '', url: 'https://', category: list.length ? list[list.length - 1].category : '', description: '' })
  });
  const toolsEditor = listEditor({
    prefix: 'tools', noun: 'Tool', path: '/api/admin/tools', key: 'tools',
    fields: [['name', 'Name', { maxlength: '60' }], ['url', 'https://… (empty = coming soon)', { maxlength: '500' }],
      ['description', 'What it does', { maxlength: '200' }]],
    blank: () => ({ name: '', url: '', description: '' })
  });

  const annEditor = listEditor({
    prefix: 'ann', noun: 'Announcement', path: '/api/admin/notices', key: 'announcements', pick: true,
    fields: [['start', 'Start date', { type: 'date' }], ['end', 'End date', { type: 'date' }], ['text', 'What it says', { maxlength: '200' }]],
    blank: () => ({ text: '', start: today(), end: today() })
  });
  const cdEditor = listEditor({
    prefix: 'cd', noun: 'Countdown', path: '/api/admin/notices', key: 'countdowns', pick: true,
    fields: [['date', 'Date', { type: 'date' }], ['title', 'What it counts down to', { maxlength: '60' }]],
    blank: () => ({ title: '', date: addDays(today(), 30) })
  });
  $('words-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const r = await api('PUT', '/api/admin/notices', { blockedWords: $('words').value.split(/[\n,]/).map((w) => w.trim()).filter(Boolean) });
      $('words').value = r.blockedWords.join('\n');
      toast('Words saved');
    });
  });

  // ---- needs attention: groups to approve, reported classwork, tool suggestions
  async function renderQueue() {
    const [groups, reported, ideas] = await Promise.all([
      api('GET', '/api/groups'), api('GET', '/api/admin/classwork'), api('GET', '/api/admin/tool-suggestions')]);
    const pending = groups.filter((g) => !g.approved);
    const act = (fn, message) => (e) => busy(e.currentTarget, async () => { await fn(); toast(message); await renderQueue(); });
    const rows = [
      ...pending.map((g) => h('div', { class: 'list-row' },
        h('div', null, h('span', { class: 'badge vis' }, 'New group'), ' ', h('a', { href: `group.html?id=${encodeURIComponent(g.id)}` }, h('strong', null, g.name)),
          h('div', { class: 'small muted' }, `${GROUP_KINDS[g.kind]}${g.description ? ` · ${g.description.slice(0, 120)}` : ''}`)),
        h('div', { class: 'row nowrap' },
          h('button', { class: 'btn small', type: 'button', onclick: act(() => api('PUT', `/api/admin/groups/${g.id}`, { approved: true }), `${g.name} approved`) }, 'Approve'),
          h('button', { class: 'linklike danger', type: 'button', onclick: (e) => { if (confirm(`Delete the group ${g.name}?`)) act(() => api('DELETE', `/api/groups/${g.id}`), 'Group deleted')(e); } }, 'Delete')))),
      ...reported.map((i) => h('div', { class: 'list-row' },
        h('div', null, h('span', { class: `badge kind-${i.kind}` }, KIND_NAMES[i.kind]), ' ', h('strong', null, i.title),
          h('div', { class: 'small muted' }, `${i.className}${i.teacher ? ` · ${i.teacher}` : ''} · due ${fmtShortDay(i.due)} · by ${i.by} · ${i.reports} report${i.reports === 1 ? '' : 's'}${i.hidden ? ' · hidden' : ''}`),
          i.notes ? h('div', { class: 'small' }, i.notes) : null),
        h('div', { class: 'row nowrap' },
          h('button', { class: 'btn small secondary', type: 'button', onclick: act(() => api('POST', `/api/admin/classwork/${i.id}/keep`, {}), 'Kept') }, 'Keep'),
          h('button', { class: 'linklike danger', type: 'button', onclick: act(() => api('DELETE', `/api/classwork/${i.id}`), 'Deleted') }, 'Delete')))),
      ...ideas.map((t) => h('div', { class: 'list-row' },
        h('div', null, h('span', { class: 'badge vis' }, 'Tool idea'), ' ', h('strong', null, t.name),
          h('div', { class: 'small muted' }, [t.url, t.description, t.by ? `from ${t.by.name}` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'row nowrap' },
          h('button', { class: 'btn small', type: 'button', onclick: act(async () => toolsEditor.set(await api('POST', `/api/admin/tool-suggestions/${t.id}/accept`, {})), 'Added to Tools') }, 'Add to Tools'),
          h('button', { class: 'linklike danger', type: 'button', onclick: act(() => api('DELETE', `/api/admin/tool-suggestions/${t.id}`), 'Dismissed') }, 'Dismiss'))))
    ];
    fill($('queue'), rows.length ? rows : h('p', { class: 'muted small' }, 'Nothing waiting. 🎉'));
  }

  // ---- restore
  const fileInput = $('restore-file');
  const confirmInput = $('restore-confirm');
  const syncRestore = () => { $('restore-btn').disabled = !(fileInput.files.length && confirmInput.value.trim().toUpperCase() === 'RESTORE'); };
  fileInput.addEventListener('change', syncRestore);
  confirmInput.addEventListener('input', syncRestore);
  $('restore-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('restore-btn'), async () => {
      const file = fileInput.files[0];
      if (file.size > 12 * 1024 * 1024) throw new Error('That file is too big (12 MB is the limit).');
      let data;
      try { data = JSON.parse(await file.text()); } catch (err) { throw new Error('That file is not a valid backup.'); }
      const r = await api('POST', '/api/admin/restore', data);
      toast(`Restored ${r.users} people and ${r.events} events${r.droppedEvents ? ` (${r.droppedEvents} invalid events skipped)` : ''}`);
      setTimeout(() => location.reload(), 1500);
    });
  });

  try {
    [status, users, info] = await Promise.all([api('GET', '/api/admin/status'), api('GET', '/api/admin/users'), loadCalendar(true)]);
  } catch (e) {
    errBox.hidden = false;
    errBox.textContent = e.message;
    return;
  }
  const todayLetter = dayInfo(info.calendar, today()).dayLetter;
  if (todayLetter) $('anchor-letter').value = todayLetter;
  $('admin-body').hidden = false;
  renderSetup();
  renderCalendar();
  renderUsers();
  try { linksEditor.set(await api('GET', '/api/links')); } catch (e) { fill($('links-editor'), h('p', { class: 'notice error' }, e.message)); }
  try { toolsEditor.set(await api('GET', '/api/tools')); } catch (e) { fill($('tools-editor'), h('p', { class: 'notice error' }, e.message)); }
  try { await renderQueue(); } catch (e) { fill($('queue'), h('p', { class: 'notice error' }, e.message)); }
  try {
    const n = await api('GET', '/api/admin/notices');
    annEditor.set(n.announcements);
    cdEditor.set(n.countdowns);
    $('words').value = n.blockedWords.join('\n');
  } catch (e) { fill($('ann-editor'), h('p', { class: 'notice error' }, e.message)); }
})();
