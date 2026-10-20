// Admin, in tabs: Overview (what needs fixing or doing), Calendar (a month you click on), People,
// Announcements, Blocked words, Links & tools, Feedback, Audit log (owners) and Backup.
(async function () {
  renderNav('admin');
  const me = await requireLogin();
  const errBox = $('admin-error');
  if (!me.admin) {
    errBox.hidden = false;
    errBox.textContent = 'This page is for admins only.';
    return;
  }
  const { addDays, dayInfo, nextSchoolDay } = MHSCalendar;
  const TYPE_NAMES = { daily: 'Regular', advisory: 'Advisory', early_release: 'Early release' };
  const POSTING_NAMES = { verified: 'admins and verified people', everyone: 'any signed-in student', admins: 'admins only' };
  const WEEKDAYS = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday']];
  let info, status, users = [];

  const today = () => schoolClock(info).date;
  const isWeekday = (d) => { const w = utcDate(d).getUTCDay(); return w >= 1 && w <= 5; };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function fmtAgo(ms) {
    if (!ms) return 'never';
    const d = Math.floor((Date.now() - ms) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : new Date(ms).toLocaleDateString();
  }
  const fmtWhen = (ms) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

  // ---- the dialog used for editing (people, links, tools, announcements, countdowns)
  const dlg = $('dlg');
  function openDialog(title, ...content) {
    fill(dlg, h('div', { class: 'dialog-head' }, h('h2', { id: 'dlg-title' }, title),
      h('button', { class: 'linklike', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')), content);
    dlg.showModal();
  }
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // a click outside the box
  // A form in the dialog: fields [{ key, label, type, attrs, options }]; onSave(values) saves and closes.
  function formDialog(title, fields, values, onSave, extra) {
    const inputs = {};
    const form = h('form', { class: 'form-grid' },
      fields.map((f) => {
        let el;
        if (f.type === 'select') el = h('select', null, f.options.map(([v, label]) => h('option', { value: v, selected: values[f.key] === v }, label)));
        else if (f.type === 'textarea') { el = h('textarea', { rows: '3', ...f.attrs }); el.value = values[f.key] || ''; }
        else if (f.type === 'checkbox') el = h('input', { type: 'checkbox', checked: !!values[f.key] });
        else { el = h('input', { type: f.type || 'text', ...f.attrs }); el.value = values[f.key] == null ? '' : values[f.key]; }
        inputs[f.key] = el;
        return f.type === 'checkbox'
          ? h('label', { class: 'check wide' }, el, h('span', null, f.label))
          : h('label', { class: f.wide ? 'wide' : null }, h('span', null, f.label), el);
      }),
      h('div', { class: 'wide row' }, h('button', { class: 'btn', type: 'submit' }, 'Save'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => dlg.close() }, 'Cancel'), extra || null));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const [k, el] of Object.entries(inputs)) out[k] = el.type === 'checkbox' ? el.checked : el.value;
      busy(e.submitter, async () => { await onSave(out); dlg.close(); });
    });
    openDialog(title, form);
    const first = form.querySelector('input:not([type=checkbox]), textarea, select');
    if (first) first.focus();
  }

  // ---- tabs (the open tab is in the address, so reloading stays on it)
  const tabs = [...$('tabs').querySelectorAll('[role=tab]')];
  const loaders = {}; // tab -> function that (re)loads it when opened
  function openTab(name, focus) {
    const tab = tabs.find((t) => t.dataset.tab === name && !t.hidden) || tabs[0];
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(`tab-${t.dataset.tab}`).hidden = !on;
    }
    if (focus) tab.focus();
    history.replaceState(null, '', `#${tab.dataset.tab}`);
    if (loaders[tab.dataset.tab]) loaders[tab.dataset.tab]().catch((e) => toast(e.message, 'error'));
  }
  window.addEventListener('hashchange', () => openTab(location.hash.slice(1))); // the Overview's #people / #feedback links
  for (const t of tabs) {
    t.setAttribute('aria-controls', `tab-${t.dataset.tab}`);
    t.addEventListener('click', () => openTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => { // arrow keys move between tabs
      const shown = tabs.filter((x) => !x.hidden);
      const i = shown.indexOf(t);
      const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? shown.length - 1 : null;
      if (j === null) return;
      e.preventDefault();
      openTab(shown[(j + shown.length) % shown.length].dataset.tab, true);
    });
  }
  const setCount = (id, n) => { $(id).hidden = !n; $(id).textContent = n ? String(n) : ''; };

  // ======================================================================= Overview
  function renderSetup() {
    const cal = info.calendar;
    const MARKS = { ok: '✓', bad: '✗', warn: '!', info: 'i' };
    const LABELS = { ok: 'OK', bad: 'Problem', warn: 'Warning', info: 'Note' };
    const item = (level, ...content) => ({ level, el: h('li', null, h('span', { class: `mark ${level}`, 'aria-label': LABELS[level] }, MARKS[level]), h('div', null, content)) });
    const items = [
      status.signIn ? item('ok', 'Google sign-in is configured.') : item('bad', 'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'),
      item(status.signIn ? 'info' : 'bad', 'Google redirect URI to register: ', h('code', null, status.redirectUri), ' ',
        h('button', { class: 'linklike', type: 'button', onclick: () => copyText(status.redirectUri) }, 'Copy')),
      status.allowedDomains.length
        ? item('ok', 'Only these Google Workspace domains can sign in: ', h('strong', null, status.allowedDomains.join(', ')))
        : item('warn', 'Any Google account can sign in. Set ALLOWED_DOMAINS (your school\'s domain) to limit it.'),
      status.admins ? item('ok', `${plural(status.admins, 'owner email')} configured.`) : item('bad', 'No owners: set ADMIN_EMAILS.'),
      cal.anchorDate ? item('ok', `Day letter rotation is set (anchored ${fmtShortDay(cal.anchorDate)}).`)
        : item('warn', 'The day letter has not been set. Set it on the Calendar tab.'),
      status.secureCookies ? item('ok', 'Cookies are HTTPS-only.') : item('warn', 'PUBLIC_URL is not https, so cookies are not marked Secure. Use https in production.'),
      status.lastSnapshot ? item('ok', `Latest automatic snapshot: ${status.lastSnapshot.replace(/^db-|\.json$/g, '')}.`) : item('warn', 'No automatic snapshot yet.'),
      item('info', `Event posting: ${POSTING_NAMES[status.eventPosting]}. School time zone: ${status.tz}.`)
    ];
    // problems only when something is wrong; everything is under "Site settings"
    const problems = items.filter((i) => i.level === 'bad' || i.level === 'warn');
    $('problems-card').hidden = !problems.length;
    fill($('problems'), problems.map((i) => i.el.cloneNode(true)));
    fill($('setup'), items.map((i) => i.el));
    const stat = (n, label, go) => h(go ? 'a' : 'div', { class: 'stat', href: go || null }, h('strong', null, String(n)), h('span', null, label));
    fill($('stats'),
      stat(status.users, status.users === 1 ? 'person' : 'people', '#people'),
      stat(status.events, status.events === 1 ? 'event' : 'events', 'events.html'),
      stat(status.groups, status.groups === 1 ? 'group' : 'groups', 'groups.html'),
      stat(status.feedbackNew || 0, 'new feedback', '#feedback'));
    setCount('count-feedback', status.feedbackNew || 0);
    setCount('count-review', (status.reportsOpen || 0) + (status.photosPending || 0));
  }
  async function renderQueue() {
    const [groups, ideas] = await Promise.all([api('GET', '/api/groups'), api('GET', '/api/admin/tool-suggestions')]);
    const pending = groups.filter((g) => !g.approved);
    const act = (fn, message) => (e) => busy(e.currentTarget, async () => { await fn(); toast(message); await renderQueue(); });
    const rows = [
      ...pending.map((g) => h('div', { class: 'list-row' },
        h('div', null, h('span', { class: 'badge vis' }, 'New group'), ' ', h('a', { href: `group.html?id=${encodeURIComponent(g.id)}` }, h('strong', null, g.name)),
          h('div', { class: 'small muted' }, `${GROUP_KINDS[g.kind]}${g.description ? ` · ${g.description.slice(0, 120)}` : ''}`)),
        h('div', { class: 'row nowrap' },
          h('button', { class: 'btn small', type: 'button', onclick: act(() => api('PUT', `/api/admin/groups/${g.id}`, { approved: true }), `${g.name} approved`) }, 'Approve'),
          h('button', { class: 'linklike danger', type: 'button', onclick: (e) => { if (confirm(`Delete the group ${g.name}?`)) act(() => api('DELETE', `/api/groups/${g.id}`), 'Group deleted')(e); } }, 'Delete')))),
      ...ideas.map((t) => h('div', { class: 'list-row' },
        h('div', null, h('span', { class: 'badge vis' }, 'Tool idea'), ' ', h('strong', null, t.name),
          h('div', { class: 'small muted' }, [t.url, t.description, t.by ? `from ${t.by.name}` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'row nowrap' },
          h('button', { class: 'btn small', type: 'button', onclick: act(() => api('POST', `/api/admin/tool-suggestions/${t.id}/accept`, {}), 'Added to Tools') }, 'Add to tools'),
          h('button', { class: 'linklike danger', type: 'button', onclick: act(() => api('DELETE', `/api/admin/tool-suggestions/${t.id}`), 'Dismissed') }, 'Dismiss')))),
      status.reportsOpen ? h('div', { class: 'list-row' }, h('div', null, h('span', { class: 'badge urgent' }, 'Reported'), ` ${plural(status.reportsOpen, 'thing')} to review`),
        h('button', { class: 'btn small', type: 'button', onclick: () => openTab('review') }, 'Review')) : null,
      status.photosPending ? h('div', { class: 'list-row' }, h('div', null, h('span', { class: 'badge vis' }, 'Photos'), ` ${plural(status.photosPending, 'profile photo')} to approve`),
        h('button', { class: 'btn small', type: 'button', onclick: () => openTab('review') }, 'Review')) : null,
      status.feedbackNew ? h('div', { class: 'list-row' }, h('div', null, h('span', { class: 'badge vis' }, 'Feedback'), ` ${plural(status.feedbackNew, 'new message')}`),
        h('button', { class: 'btn small', type: 'button', onclick: () => openTab('feedback') }, 'Read')) : null
    ].filter(Boolean);
    setCount('count-overview', pending.length + ideas.length);
    fill($('queue'), rows.length ? rows : h('p', { class: 'muted small' }, 'Nothing waiting. 🎉'));
  }
  async function reloadStatus() { status = await api('GET', '/api/admin/status'); renderSetup(); }
  loaders.overview = async () => { await reloadStatus(); await renderQueue(); };

  // ======================================================================= Review: reports (and photos)
  const KIND_NAMES = { event: 'Event', post: 'Group post', reply: 'Group reply', poll: 'Poll', study: 'Study session', classwork: 'Class event', profile: 'Profile' };
  const REASON_NAMES = Object.fromEntries(REPORT_REASONS);
  function reportItem(r, open) {
    const reasons = r.reports.map((x) => `${REASON_NAMES[x.reason] || x.reason}${x.note ? `: "${x.note}"` : ''} (${x.by})`);
    const act = (path, message) => (e) => busy(e.currentTarget, async () => { await api('POST', `/api/admin/reports/${r.id}/${path}`, {}); toast(message); await loadReview(); await reloadStatus(); });
    return h('div', { class: 'list-row report-item' },
      h('div', { class: 'grow' },
        h('div', null, h('span', { class: 'badge vis' }, KIND_NAMES[r.kind] || r.kind), ' ', r.hidden ? h('span', { class: 'badge urgent' }, 'hidden') : null,
          ' ', h('strong', null, plural(r.reports.length, 'report'))),
        h('p', { class: 'pre report-summary' }, r.summary),
        h('div', { class: 'small muted' }, r.author ? `By ${r.author.name} (${r.author.email})` : 'By a former student', r.link ? [' · ', h('a', { href: r.link }, 'Open')] : null),
        h('ul', { class: 'small report-reasons' }, reasons.map((x) => h('li', null, x))),
        r.resolved ? h('div', { class: 'small muted' }, `${r.resolved.action === 'kept' ? 'Kept' : 'Removed'} ${fmtWhen(r.resolved.at)}`) : null),
      open ? h('div', { class: 'row nowrap' },
        h('button', { class: 'btn small secondary', type: 'button', onclick: act('keep', 'Kept') }, 'Keep'),
        h('button', {
          class: 'btn small danger', type: 'button',
          onclick: (e) => { if (confirm(r.kind === 'profile' ? 'Reset this profile (name, avatar, bio…)?' : 'Remove it for good?')) act('remove', r.kind === 'profile' ? 'Profile reset' : 'Removed')(e); }
        }, r.kind === 'profile' ? 'Reset profile' : 'Remove')) : null);
  }
  async function loadReview() {
    const q = await api('GET', '/api/admin/reports');
    fill($('report-list'), q.open.length ? q.open.map((r) => reportItem(r, true)) : h('p', { class: 'muted small' }, 'Nothing reported. 🎉'));
    $('report-done-card').hidden = !q.done.length;
    fill($('report-done'), q.done.map((r) => reportItem(r, false)));
    await loadPhotos();
  }
  // profile photos waiting for approval
  async function loadPhotos() {
    const list = await api('GET', '/api/admin/photos');
    $('photo-card').hidden = !list.length;
    fill($('photo-queue'), list.map((p) => {
      const act = (path, message) => (e) => busy(e.currentTarget, async () => { await api('POST', `/api/admin/photos/${p.user.id}/${path}`, {}); toast(message); await loadPhotos(); await reloadStatus(); });
      return h('div', { class: 'photo-item' },
        h('img', { src: p.pending, alt: `New photo from ${p.user.name}`, width: '128', height: '128' }),
        h('div', null, h('strong', null, p.user.name), h('div', { class: 'small muted' }, p.user.email)),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', 'aria-label': `Approve ${p.user.name}'s photo`, onclick: act('approve', 'Approved') }, 'Approve'),
          h('button', { class: 'btn small secondary', type: 'button', 'aria-label': `Reject ${p.user.name}'s photo`, onclick: act('reject', 'Rejected') }, 'Reject')));
    }));
  }
  loaders.review = async () => { await reloadStatus(); await loadReview(); };

  // ======================================================================= Calendar
  async function saveCalendar(next, message) {
    await api('PUT', '/api/admin/calendar', next);
    info = await loadCalendar(true);
    renderCalendar();
    renderSetup();
    if (message) toast(message);
  }
  let month = null; // 'YYYY-MM'
  let picked = null; // the day whose panel is open
  const monthOf = (d) => d.slice(0, 7);
  function shiftMonth(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  }
  function renderMonth() {
    const cal = info.calendar;
    const t = today();
    const [y, m] = month.split('-').map(Number);
    $('month-title').textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(Date.UTC(y, m - 1, 1));
    // Monday to Friday, whole weeks
    let d = `${month}-01`;
    while (utcDate(d).getUTCDay() !== 1) d = addDays(d, -1);
    const cells = [h('div', { class: 'mh' }, 'Mon'), h('div', { class: 'mh' }, 'Tue'), h('div', { class: 'mh' }, 'Wed'), h('div', { class: 'mh' }, 'Thu'), h('div', { class: 'mh' }, 'Fri')];
    for (; monthOf(d) <= month || utcDate(d).getUTCDay() !== 1; d = addDays(d, 1)) {
      if (!isWeekday(d)) continue;
      const di = dayInfo(cal, d);
      const inMonth = monthOf(d) === month;
      const day = d;
      const cls = ['mday', inMonth ? null : 'other', di.schoolDay ? null : 'off', di.scheduleType === 'advisory' && di.schoolDay ? 'adv' : null,
        di.scheduleType === 'early_release' && di.schoolDay ? 'er' : null, d === t ? 'today' : null, d === picked ? 'picked' : null].filter(Boolean).join(' ');
      const note = di.schoolDay ? (di.scheduleType !== 'daily' ? TYPE_NAMES[di.scheduleType] : '') : (di.label || 'No school');
      cells.push(h('button', {
        type: 'button', class: cls, 'aria-pressed': String(d === picked),
        'aria-label': `${fmtLongDay(d)}: ${di.schoolDay ? `Day ${di.dayLetter || '?'}, ${TYPE_NAMES[di.scheduleType]}` : note}`,
        onclick: () => { picked = picked === day ? null : day; renderMonth(); renderDayPanel(); }
      }, h('span', { class: 'mnum' }, String(Number(d.slice(8)))), h('strong', { class: 'mletter' }, di.schoolDay ? di.dayLetter || '?' : '–'), h('span', { class: 'mnote' }, note)));
    }
    fill($('month'), cells);
  }
  function renderDayPanel() {
    const panel = $('day-panel');
    panel.hidden = !picked;
    if (!picked) return;
    const cal = info.calendar;
    const d = picked;
    const di = dayInfo(cal, d);
    const wd = String(utcDate(d).getUTCDay());
    const usual = cal.weekdayTypes[wd] || 'daily';
    const setType = (type) => {
      const types = { ...cal.types };
      const noSchool = { ...cal.noSchool };
      delete noSchool[d];
      if (type === usual) delete types[d]; else types[d] = type;
      return saveCalendar({ ...cal, types, noSchool }, `${fmtShortDay(d)}: ${TYPE_NAMES[type]}`);
    };
    const current = di.schoolDay ? di.scheduleType : 'off';
    const choice = (value, label) => h('button', {
      class: 'btn small' + (current === value ? '' : ' secondary'), type: 'button', 'aria-pressed': String(current === value),
      onclick: (e) => busy(e.currentTarget, () => setType(value))
    }, label);
    const offName = h('input', { type: 'text', maxlength: '60', placeholder: 'Name (optional)', 'aria-label': 'Why there is no school', value: di.label || '' });
    fill(panel,
      h('div', { class: 'row between' }, h('strong', null, fmtLongDay(d)), h('span', { class: 'small muted' }, di.schoolDay ? `Day ${di.dayLetter || '?'}` : 'No school')),
      h('div', { class: 'row' }, choice('daily', 'Regular'), choice('advisory', 'Advisory'), choice('early_release', 'Early release')),
      h('form', {
        class: 'inline-field',
        onsubmit: (e) => {
          e.preventDefault();
          busy(e.submitter, () => {
            const types = { ...cal.types }; delete types[d];
            return saveCalendar({ ...cal, types, noSchool: { ...cal.noSchool, [d]: offName.value.trim() } }, `${fmtShortDay(d)}: no school`);
          });
        }
      }, offName, h('button', { class: 'btn small' + (current === 'off' ? '' : ' secondary'), type: 'submit' }, current === 'off' ? 'Save name' : 'No school')),
      di.schoolDay ? h('p', { class: 'small' }, h('button', {
        class: 'linklike', type: 'button',
        onclick: (e) => {
          const letter = prompt(`Make ${fmtShortDay(d)} which day letter? (A, B, C or D)`, di.dayLetter || 'A');
          if (!letter) return;
          if (!/^[A-D]$/i.test(letter.trim())) { toast('Use A, B, C or D', 'error'); return; }
          busy(e.currentTarget, () => saveCalendar({ ...cal, anchorDate: d, anchorLetter: letter.trim().toUpperCase() }, 'Day letter set'));
        }
      }, 'Fix the day letter from this day on')) : null);
  }
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
    if (!month) month = monthOf(today());
    renderMonth();
    renderDayPanel();
    fill($('weekday-types'), WEEKDAYS.map(([k, name]) => {
      const sel = h('select', { 'aria-label': `${name} schedule` },
        Object.entries(TYPE_NAMES).map(([v, label]) => h('option', { value: v, selected: (cal.weekdayTypes[k] || 'daily') === v }, label)));
      sel.addEventListener('change', () => busy(sel, () => saveCalendar({ ...cal, weekdayTypes: { ...cal.weekdayTypes, [k]: sel.value } }, 'Saved')));
      return h('label', null, h('span', null, name), sel);
    }));
    const t = today();
    const groups = groupNoSchool(cal.noSchool).filter((g) => g.to >= addDays(t, -30));
    fill($('noschool-list'), groups.length ? groups.map((g) => h('div', { class: 'list-row' },
      h('div', null, h('strong', null, g.from === g.to ? fmtShortDay(g.from) : `${fmtShortDay(g.from)} – ${fmtShortDay(g.to)}`), g.label ? ` · ${g.label}` : ''),
      h('button', {
        class: 'linklike danger', type: 'button', 'aria-label': `Remove ${g.label || 'no school'} ${fmtShortDay(g.from)}`,
        onclick: (e) => busy(e.currentTarget, () => {
          const ns = { ...cal.noSchool };
          for (let d = g.from; d <= g.to; d = addDays(d, 1)) delete ns[d];
          return saveCalendar({ ...cal, noSchool: ns }, 'Removed');
        })
      }, 'Remove'))) : h('p', { class: 'muted small' }, 'None coming up.'));
    const specials = Object.keys(cal.types).filter((d) => d >= addDays(t, -30)).sort();
    fill($('type-list'), specials.length ? specials.map((d) => h('div', { class: 'list-row' },
      h('div', null, h('strong', null, fmtShortDay(d)), ` · ${TYPE_NAMES[cal.types[d]]}`),
      h('button', {
        class: 'linklike danger', type: 'button', 'aria-label': `Remove the special schedule on ${fmtShortDay(d)}`,
        onclick: (e) => busy(e.currentTarget, () => { const ty = { ...cal.types }; delete ty[d]; return saveCalendar({ ...cal, types: ty }, 'Removed'); })
      }, 'Remove'))) : h('p', { class: 'muted small' }, 'None coming up. Click a day in the month to add one.'));
    if (!$('anchor-date').value) $('anchor-date').value = t;
  }
  $('month-prev').addEventListener('click', () => { month = shiftMonth(month, -1); renderMonth(); });
  $('month-next').addEventListener('click', () => { month = shiftMonth(month, 1); renderMonth(); });
  $('month-today').addEventListener('click', () => { month = monthOf(today()); renderMonth(); });
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
      month = monthOf(from);
      await saveCalendar({ ...info.calendar, noSchool: ns }, 'Days off added');
      e.target.reset();
    });
  });

  // ======================================================================= People
  async function reloadUsers() {
    users = await api('GET', '/api/admin/users');
    renderUsers();
  }
  const badge = (on, text, cls = '') => (on ? h('span', { class: `badge ${cls}` }, text) : null);
  function renderUsers() {
    const q = $('people-q').value.trim().toLowerCase();
    const f = $('people-filter').value;
    const DAYS_30 = 30 * 86400000;
    const shown = users.filter((u) => (!q || `${u.name} ${u.fullName} ${u.email}`.toLowerCase().includes(q))
      && (f === 'archived' ? !!u.archived : !u.archived || f === '')
      && (!f || f === 'archived' || (f === 'admin' && u.admin) || (f === 'verified' && u.verified) || (f === 'locked' && u.profileLocked)
        || (f === 'inactive' && Date.now() - u.lastLogin > DAYS_30) || (f === 'seniors' && u.grade === 12)));
    $('people-count').textContent = `${shown.length} of ${users.length} ${users.length === 1 ? 'person' : 'people'}`;
    fill($('users'), shown.length ? shown.map((u) => h('button', { class: 'person-card', type: 'button', dataset: { id: u.id }, 'aria-label': `${u.name}, ${u.email}`, onclick: () => personDialog(u) },
      avatarEl(u, 40),
      h('span', { class: 'pc-main' }, h('strong', null, u.name), h('span', { class: 'small muted pc-email' }, u.email),
        h('span', { class: 'pc-badges' }, badge(u.owner, 'owner'), badge(u.admin && !u.owner, 'admin'), badge(u.verified, 'verified', 'vis'), badge(u.profileLocked, 'locked', 'vis'),
          badge(!!u.archived, 'archived', 'urgent'), badge(!!u.pendingPhoto, 'photo to approve', 'vis'))),
      h('span', { class: 'small muted pc-seen' }, fmtAgo(u.lastLogin)))) : h('p', { class: 'muted' }, 'No one matches.'));
  }
  $('people-q').addEventListener('input', renderUsers);
  $('people-filter').addEventListener('change', renderUsers);

  // One person: what we know, and everything an admin can do.
  function personDialog(u) {
    const change = (body, message) => async (e) => busy(e.currentTarget, async () => {
      await api('PUT', `/api/admin/users/${u.id}`, body);
      await reloadUsers();
      toast(message);
      const fresh = users.find((x) => x.id === u.id);
      if (fresh) personDialog(fresh); else dlg.close();
    });
    const details = [u.fullName && u.fullName !== u.name ? `Google name: ${u.fullName}` : null, u.pronouns, u.grade ? `${u.grade}th grade` : null,
      `${plural(u.friends, 'friend')}`, u.searchable ? null : 'hidden from search', `joined ${fmtAgo(u.created)}`, `last signed in ${fmtAgo(u.lastLogin)}`].filter(Boolean);
    openDialog(u.name,
      h('div', { class: 'person' }, avatarEl(u, 56), h('div', null,
        h('div', null, h('strong', null, u.name), ' ', badge(u.owner, 'owner'), ' ', badge(u.admin && !u.owner, 'admin'), ' ', badge(u.verified, 'verified', 'vis'), ' ', badge(u.profileLocked, 'locked', 'vis')),
        h('div', { class: 'small' }, u.email),
        h('div', { class: 'small muted' }, details.join(' · ')))),
      u.bio ? h('p', { class: 'small' }, u.bio) : null,
      u.interests && u.interests.length ? h('p', { class: 'small muted' }, `Interests: ${u.interests.join(', ')}`) : null,
      u.archived ? h('p', { class: 'notice small' }, `Archived at graduation; deleted ${fmtShortDay(new Date(u.archived.deleteAfter).toISOString().slice(0, 10))} unless you restore it. `,
        h('button', { class: 'btn small', type: 'button', onclick: change({ archived: false }, `${u.name} restored`) }, 'Restore account')) : null,
      h('div', { class: 'action-list' },
        u.admin ? h('p', { class: 'small muted' }, 'Admins can always post events.') : h('button', {
          class: 'btn small' + (u.verified ? ' secondary' : ''), type: 'button', 'aria-label': `${u.verified ? 'Unverify' : 'Verify'} ${u.name}`,
          onclick: change({ verified: !u.verified }, u.verified ? `${u.name} can no longer post events` : `${u.name} can now post events`)
        }, u.verified ? 'Unverify (stop posting events)' : 'Verify (can post events for everyone)'),
        h('button', { class: 'btn small secondary', type: 'button', onclick: () => editProfile(u) }, 'Edit profile'),
        u.photo || u.pendingPhoto ? h('button', {
          class: 'btn small secondary', type: 'button',
          onclick: (e) => { if (confirm(`Remove ${u.name}'s photo?`)) busy(e.currentTarget, async () => { await api('DELETE', `/api/admin/users/${u.id}/photo`); await reloadUsers(); toast('Photo removed'); personDialog(users.find((x) => x.id === u.id)); }); }
        }, 'Remove photo') : null,
        h('button', {
          class: 'btn small secondary', type: 'button',
          onclick: (e) => { if (confirm(`Reset ${u.name}'s profile to their Google first name and last initial, and clear their avatar, pronouns, grade, bio and interests?`)) change({ reset: true }, 'Profile reset')(e); }
        }, 'Reset profile'),
        h('button', { class: 'btn small secondary', type: 'button', onclick: change({ profileLocked: !u.profileLocked }, u.profileLocked ? 'Profile unlocked' : 'Profile locked') },
          u.profileLocked ? 'Unlock profile' : 'Lock profile'),
        u.owner || u.id === me.id ? null : h('button', {
          class: 'btn small secondary', type: 'button', 'aria-label': `${u.admin ? 'Remove admin from' : 'Make admin:'} ${u.name}`,
          onclick: (e) => {
            if (!confirm(u.admin ? `Remove ${u.name}'s admin access?` : `Make ${u.name} an admin? They will be able to manage people, events, links, the calendar and backups.`)) return;
            change({ admin: !u.admin }, u.admin ? `${u.name} is no longer an admin` : `${u.name} is now an admin`)(e);
          }
        }, u.admin ? 'Remove admin' : 'Make admin'),
        u.id === me.id || (u.owner && !me.owner) ? null : h('button', {
          class: 'btn small danger', type: 'button', 'aria-label': `Remove ${u.name}`,
          onclick: (e) => {
            if (!confirm(`Remove ${u.name} (${u.email})? This deletes their account, classes and events.`)) return;
            busy(e.currentTarget, async () => { await api('DELETE', `/api/admin/users/${u.id}`); dlg.close(); await reloadUsers(); toast('Removed'); });
          }
        }, 'Remove account')));
  }
  function editProfile(u) {
    formDialog(`Edit ${u.name}`, [
      { key: 'name', label: 'Display name', attrs: { maxlength: '40', required: true } },
      { key: 'pronouns', label: 'Pronouns', attrs: { maxlength: '20' } },
      { key: 'grade', label: 'Grade', type: 'select', options: [['', 'Not set'], ['9', '9th'], ['10', '10th'], ['11', '11th'], ['12', '12th']] },
      { key: 'bio', label: 'Bio', type: 'textarea', wide: true, attrs: { maxlength: '160' } },
      { key: 'interests', label: 'Interests (comma-separated, up to 5)', wide: true, attrs: { maxlength: '140' } }
    ], { ...u, grade: u.grade ? String(u.grade) : '', interests: (u.interests || []).join(', ') }, async (v) => {
      await api('PUT', `/api/admin/users/${u.id}`, {
        name: v.name, pronouns: v.pronouns, grade: v.grade || null, bio: v.bio, interests: v.interests.split(',').map((s) => s.trim()).filter(Boolean)
      });
      await reloadUsers();
      toast('Profile saved');
    });
  }
  function renderGraduation() {
    $('grad-date').value = status.graduation || '';
    $('grad-note').textContent = status.graduation
      ? `${status.graduation <= today() ? 'Graduation was' : 'Graduation is'} ${fmtLongDay(status.graduation)}. ${status.seniors} senior${status.seniors === 1 ? '' : 's'} (12th grade) ${status.graduation <= today() ? 'left' : 'will be archived'}${status.archived ? `; ${status.archived} archived account${status.archived === 1 ? '' : 's'}` : ''}.`
      : `No graduation day set. ${status.seniors} senior${status.seniors === 1 ? '' : 's'} (12th grade).`;
  }
  const saveGraduation = (graduation) => async () => { await api('PUT', '/api/admin/school', { graduation }); await reloadStatus(); renderGraduation(); toast('Saved'); };
  $('grad-form').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, saveGraduation($('grad-date').value || null)); });
  $('grad-clear').addEventListener('click', (e) => busy(e.currentTarget, saveGraduation(null)));
  loaders.people = async () => { await reloadUsers(); await reloadStatus(); renderGraduation(); };

  // ======================================================================= lists edited in a dialog
  // links, tools, announcements, countdowns: each change saves the whole list right away.
  function collection({ listEl, addBtn, noun, path, key, pick, fields, blank, row, groupBy }) {
    let items = [];
    const save = async (next, message) => {
      const saved = await api('PUT', path, { [key]: next });
      items = pick ? saved[key] : saved;
      render();
      toast(message);
    };
    const edit = (i) => formDialog(i === null ? `Add ${noun}` : `Edit ${noun}`, fields(items), i === null ? blank(items) : items[i], async (v) => {
      const next = items.slice();
      if (i === null) next.push({ ...v }); else next[i] = { ...items[i], ...v };
      await save(next, i === null ? 'Added' : 'Saved');
    });
    function render() {
      const rowFor = (item, i) => {
        const move = (d) => (e) => busy(e.currentTarget, () => { const next = items.slice(); [next[i], next[i + d]] = [next[i + d], next[i]]; return save(next, 'Moved'); });
        return h('div', { class: 'list-row' }, h('div', { class: 'grow' }, row(item)),
          h('div', { class: 'row nowrap' },
            h('button', { class: 'linklike', type: 'button', 'aria-label': `Move ${noun} ${i + 1} up`, onclick: move(-1), disabled: i === 0 }, '↑'),
            h('button', { class: 'linklike', type: 'button', 'aria-label': `Move ${noun} ${i + 1} down`, onclick: move(1), disabled: i === items.length - 1 }, '↓'),
            h('button', { class: 'linklike', type: 'button', 'aria-label': `Edit ${noun} ${i + 1}`, onclick: () => edit(i) }, 'Edit'),
            h('button', {
              class: 'linklike danger', type: 'button', 'aria-label': `Remove ${noun} ${i + 1}`,
              onclick: (e) => { if (confirm(`Remove this ${noun}?`)) busy(e.currentTarget, () => save(items.filter((_, j) => j !== i), 'Removed')); }
            }, 'Remove')));
      };
      if (!items.length) { fill(listEl, h('p', { class: 'muted small' }, `No ${noun}s yet.`)); return; }
      if (!groupBy) { fill(listEl, items.map(rowFor)); return; }
      const groups = new Map();
      items.forEach((item, i) => { const g = groupBy(item); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(rowFor(item, i)); });
      fill(listEl, [...groups].map(([g, rows]) => h('div', { class: 'link-group' }, h('h3', null, g), rows)));
    }
    addBtn.addEventListener('click', () => edit(null));
    return { set(list) { items = list; render(); } };
  }
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
  const linksList = collection({
    listEl: $('links-list'), addBtn: $('links-add'), noun: 'link', path: '/api/admin/links', key: 'links', groupBy: (l) => l.category,
    fields: (items) => [
      { key: 'title', label: 'Title', attrs: { maxlength: '80', required: true } },
      { key: 'url', label: 'Web address', type: 'url', attrs: { maxlength: '500', required: true, placeholder: 'https://…' } },
      { key: 'category', label: 'Category', attrs: { maxlength: '40', required: true, list: 'link-categories', placeholder: [...new Set(items.map((l) => l.category))].join(', ') } },
      { key: 'description', label: 'Short description (optional)', wide: true, attrs: { maxlength: '160' } }],
    blank: (items) => ({ title: '', url: 'https://', category: items.length ? items[items.length - 1].category : '', description: '' }),
    row: (l) => [h('strong', null, l.title), h('div', { class: 'small muted' }, [host(l.url), l.description].filter(Boolean).join(' · '))]
  });
  const toolsList = collection({
    listEl: $('tools-list'), addBtn: $('tools-add'), noun: 'tool', path: '/api/admin/tools', key: 'tools',
    fields: () => [
      { key: 'name', label: 'Name', attrs: { maxlength: '60', required: true } },
      { key: 'url', label: 'Web address (empty = coming soon)', type: 'url', attrs: { maxlength: '500', placeholder: 'https://…' } },
      { key: 'description', label: 'What it does', wide: true, attrs: { maxlength: '200' } }],
    blank: () => ({ name: '', url: '', description: '' }),
    row: (t) => [h('strong', null, t.name), ' ', t.url ? null : h('span', { class: 'badge muted' }, 'Coming soon'), h('div', { class: 'small muted' }, [t.url ? host(t.url) : null, t.description].filter(Boolean).join(' · '))]
  });
  const annList = collection({
    listEl: $('ann-list'), addBtn: $('ann-add'), noun: 'announcement', path: '/api/admin/notices', key: 'announcements', pick: true,
    fields: () => [
      { key: 'text', label: 'What it says', wide: true, attrs: { maxlength: '200', required: true } },
      { key: 'start', label: 'From', type: 'date', attrs: { required: true } },
      { key: 'end', label: 'Until', type: 'date', attrs: { required: true } },
      { key: 'urgent', label: 'Urgent (red, like a snow day)', type: 'checkbox' }],
    blank: () => ({ text: '', start: today(), end: today(), urgent: false }),
    row: (a) => [h('strong', null, a.text), ' ', a.urgent ? h('span', { class: 'badge urgent' }, 'urgent') : null,
      h('div', { class: 'small muted' }, a.start === a.end ? fmtShortDay(a.start) : `${fmtShortDay(a.start)} – ${fmtShortDay(a.end)}`, a.end < today() ? ' · over' : '')]
  });
  const cdList = collection({
    listEl: $('cd-list'), addBtn: $('cd-add'), noun: 'countdown', path: '/api/admin/notices', key: 'countdowns', pick: true,
    fields: () => [{ key: 'title', label: 'Counts down to', attrs: { maxlength: '60', required: true } }, { key: 'date', label: 'Date', type: 'date', attrs: { required: true } }],
    blank: () => ({ title: '', date: addDays(today(), 30) }),
    row: (c) => [h('strong', null, c.title), h('div', { class: 'small muted' }, fmtShortDay(c.date), c.date < today() ? ' · over' : '')]
  });
  // categories offered while typing a link's category
  document.body.append(h('datalist', { id: 'link-categories' }));
  loaders.links = async () => {
    const [links, tools] = await Promise.all([api('GET', '/api/links'), api('GET', '/api/tools')]);
    fill($('link-categories'), [...new Set(links.map((l) => l.category))].map((c) => h('option', { value: c })));
    linksList.set(links);
    toolsList.set(tools);
  };
  let words = [];
  function renderWords() {
    fill($('word-chips'), words.length ? words.map((w) => h('span', { class: 'chip' }, w, h('button', {
      class: 'linklike', type: 'button', 'aria-label': `Unblock ${w}`,
      onclick: (e) => busy(e.currentTarget, () => saveWords(words.filter((x) => x !== w), `"${w}" unblocked`))
    }, '×'))) : h('p', { class: 'muted small' }, 'No extra words yet.'));
  }
  async function saveWords(list, message) {
    words = (await api('PUT', '/api/admin/notices', { blockedWords: list })).blockedWords;
    renderWords();
    toast(message);
  }
  $('word-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const add = $('word-new').value.split(',').map((w) => w.trim()).filter(Boolean);
      await saveWords([...words, ...add], add.length === 1 ? `"${add[0]}" blocked` : 'Words blocked');
      $('word-new').value = '';
    });
  });
  loaders.notices = loaders.words = async () => {
    const n = await api('GET', '/api/admin/notices');
    annList.set(n.announcements);
    cdList.set(n.countdowns);
    words = n.blockedWords;
    renderWords();
  };

  // ======================================================================= Feedback
  const FB_TYPES = { bug: "🐞 Something's broken", idea: '💡 Idea', question: '❓ Question', other: '💬 Other' };
  let inbox = [];
  function renderFeedback() {
    const f = $('fb-filter').value;
    const shown = inbox.filter((x) => (f === 'open' ? x.status !== 'done' : !f || x.status === f));
    $('fb-count').textContent = `${shown.length} shown`;
    fill($('fb-list'), shown.length ? shown.map((x) => {
      const reply = h('textarea', { rows: '2', maxlength: '2000', placeholder: 'Write a reply. They see it on their Feedback page.', 'aria-label': `Reply to ${x.from ? x.from.name : 'this'}` });
      const setStatus = (s) => (e) => busy(e.currentTarget, async () => { await api('PUT', `/api/admin/feedback/${x.id}`, { status: s }); await loadFeedback(); });
      return h('div', { class: 'card feedback-item' + (x.status === 'new' ? ' unread' : '') },
        h('div', { class: 'row between' }, h('strong', null, FB_TYPES[x.type]), h('span', { class: `badge status-${x.status}` }, x.status)),
        h('p', { class: 'pre' }, x.message),
        h('div', { class: 'small muted' }, x.from ? `${x.from.name} (${x.from.email})` : 'Former student', ` · ${fmtWhen(x.created)}`, x.page ? ` · from ${x.page}` : ''),
        x.replies.map((r) => h('div', { class: 'reply' }, h('div', { class: 'small' }, h('strong', null, r.by), ` · ${fmtWhen(r.at)}`), h('p', { class: 'pre' }, r.text))),
        x.from ? h('form', {
          class: 'stack reply-form',
          onsubmit: (e) => {
            e.preventDefault();
            busy(e.submitter, async () => { await api('POST', `/api/admin/feedback/${x.id}/reply`, { text: reply.value }); toast('Reply sent'); await loadFeedback(); });
          }
        }, reply, h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'Send reply'),
          x.status !== 'seen' ? h('button', { class: 'btn small secondary', type: 'button', onclick: setStatus('seen') }, x.status === 'done' ? 'Reopen' : 'Mark seen') : null,
          x.status !== 'done' ? h('button', { class: 'btn small secondary', type: 'button', onclick: setStatus('done') }, 'Done') : null,
          h('button', {
            class: 'linklike danger', type: 'button',
            onclick: (e) => { if (confirm('Delete this feedback?')) busy(e.currentTarget, async () => { await api('DELETE', `/api/admin/feedback/${x.id}`); await loadFeedback(); }); }
          }, 'Delete'))) : null);
    }) : h('p', { class: 'muted' }, f === 'open' ? 'All caught up. 🎉' : 'Nothing here.'));
  }
  async function loadFeedback() {
    inbox = await api('GET', '/api/admin/feedback');
    setCount('count-feedback', inbox.filter((x) => x.status === 'new').length);
    renderFeedback();
  }
  $('fb-filter').addEventListener('change', renderFeedback);
  loaders.feedback = loadFeedback;

  // ======================================================================= Audit log (owners)
  // Plain words for the most common entries; anything else shows as recorded.
  const ACTIONS = {
    'sign-in': 'Signed in', 'sign-in (new account)': 'Signed in for the first time', 'sign-in refused (domain)': 'Sign-in refused (not a school account)',
    'refused (not an admin)': 'Tried an admin action (refused)', 'backup downloaded': 'Downloaded a backup', 'audit log downloaded': 'Downloaded the audit log',
    'POST /api/logout': 'Signed out', 'POST /api/me/agree': 'Agreed to the Privacy & Terms', 'PUT /api/me': 'Changed their profile', 'DELETE /api/me': 'Deleted their account',
    'PUT /api/classes': 'Changed their classes', 'POST /api/events': 'Added an event', 'DELETE /api/events/:id': 'Deleted an event',
    'POST /api/events/:id/signup': 'Signed up / un-signed up', 'POST /api/friends/request': 'Sent a friend request', 'DELETE /api/friends/:id': 'Removed a friend',
    'POST /api/groups': 'Started a group', 'PUT /api/groups/:id': 'Edited a group', 'DELETE /api/groups/:id': 'Deleted a group',
    'POST /api/groups/:id/posts': 'Posted in a group', 'DELETE /api/groups/:id/posts/:pid': 'Deleted a group post', 'POST /api/feedback': 'Sent feedback',
    'PUT /api/admin/users/:id': 'Changed a person (admin)', 'DELETE /api/admin/users/:id': 'Removed a person (admin)', 'PUT /api/admin/calendar': 'Changed the school calendar',
    'PUT /api/admin/notices': 'Changed announcements, countdowns or blocked words', 'PUT /api/admin/links': 'Changed the links', 'PUT /api/admin/tools': 'Changed the tools',
    'PUT /api/admin/groups/:id': 'Approved a group', 'POST /api/admin/restore': 'Restored a backup', 'POST /api/admin/feedback/:id/reply': 'Replied to feedback',
    'PUT /api/admin/feedback/:id': 'Changed a feedback status', 'DELETE /api/admin/feedback/:id': 'Deleted feedback',
    'POST /api/admin/tool-suggestions/:id/accept': 'Added a suggested tool', 'DELETE /api/admin/tool-suggestions/:id': 'Dismissed a tool idea',
    'POST /api/tools/suggestions': 'Suggested a tool', 'POST /api/friends/:id/accept': 'Accepted a friend request', 'PUT /api/friends/:id': 'Changed what a friend sees',
    'POST /api/friends/suggestions/:id/hide': 'Hid a friend suggestion', 'POST /api/me/friend-code': 'Got a new friend code',
    'POST /api/me/calendar': 'Made a calendar link', 'DELETE /api/me/calendar': 'Turned off their calendar link',
    'POST /api/groups/:id/join': 'Joined (or asked to join) a group', 'POST /api/groups/:id/leave': 'Left a group', 'PUT /api/groups/:id/members/:uid': 'Changed a group member',
    'POST /api/groups/:id/posts/:pid/replies': 'Replied in a group', 'DELETE /api/groups/:id/posts/:pid/replies/:rid': 'Deleted a group reply',
    'POST /api/groups/:id/polls': 'Started a poll', 'POST /api/groups/:id/polls/:pid/vote': 'Voted in a poll', 'PUT /api/groups/:id/polls/:pid': 'Closed or edited a poll',
    'DELETE /api/groups/:id/polls/:pid': 'Deleted a poll', 'POST /api/study': 'Planned a study session', 'POST /api/study/:id/going': 'Said going / not going to a study session',
    'DELETE /api/study/:id': 'Deleted a study session', 'POST /api/tasks': 'Added a Google Task', 'PUT /api/tasks/:list/:task': 'Checked off a Google Task',
    'DELETE /api/tasks/connection': 'Disconnected Google Tasks'
  };
  let auditNext = null;
  const short = (v) => { if (v == null) return ''; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 160 ? `${s.slice(0, 160)}…` : s; };
  async function loadAudit(more) {
    const q = $('audit-q').value.trim();
    const r = await api('GET', `/api/admin/audit?q=${encodeURIComponent(q)}${more && auditNext !== null ? `&before=${auditNext}` : ''}`);
    auditNext = r.next;
    $('audit-more').hidden = r.next === null;
    const rows = r.entries.map((e) => h('tr', null,
      h('td', { class: 'nowrap small' }, fmtWhen(Date.parse(e.at))),
      h('td', { class: 'small' }, e.actor ? [h('strong', null, e.actor.name), h('div', { class: 'muted' }, e.actor.email)] : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'small' }, ACTIONS[e.action] || e.action, ACTIONS[e.action] ? h('div', { class: 'muted mono' }, e.action) : null),
      h('td', { class: 'small mono audit-detail' }, short(e.target), e.target && e.detail ? ' ' : '', short(e.detail), e.ip ? h('div', { class: 'muted' }, e.ip) : null)));
    if (more) add($('audit-rows'), rows); else fill($('audit-rows'), rows.length ? rows : h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'Nothing found.')));
  }
  $('audit-form').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, () => loadAudit(false)); });
  $('audit-more').addEventListener('click', (e) => busy(e.currentTarget, () => loadAudit(true)));
  if (me.owner) { $('audit-tab').hidden = false; loaders.audit = () => loadAudit(false); }

  // ======================================================================= Backup
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

  // ======================================================================= start
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
  renderQueue().catch(() => {});
  openTab(location.hash.slice(1) || 'overview');
})();
