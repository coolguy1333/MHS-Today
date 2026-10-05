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
      item('info', `${status.users} ${status.users === 1 ? 'person' : 'people'}, ${status.events} event${status.events === 1 ? '' : 's'}. Event posting: ${status.eventPosting === 'admins' ? 'admins only' : 'any signed-in student'}. School time zone: ${status.tz}.`));
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
  function renderUsers() {
    fill($('users'), users.map((u) => h('tr', null,
      h('td', null, u.name, u.admin ? [' ', h('span', { class: 'badge' }, 'admin')] : null),
      h('td', { class: 'small' }, u.email),
      h('td', { class: 'small muted nowrap' }, fmtAgo(u.lastLogin)),
      h('td', null, u.id === me.id ? null : h('button', {
        class: 'linklike danger', type: 'button', 'aria-label': `Remove ${u.name}`,
        onclick: (e) => {
          if (!confirm(`Remove ${u.name} (${u.email})? This deletes their account, classes and events.`)) return;
          busy(e.currentTarget, async () => { await api('DELETE', `/api/admin/users/${u.id}`); users = await api('GET', '/api/admin/users'); status = await api('GET', '/api/admin/status'); renderUsers(); renderSetup(); toast('Removed'); });
        }
      }, 'Remove')))));
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
})();
