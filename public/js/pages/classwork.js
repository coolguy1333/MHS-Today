// Assignments: the signed-in person's own Google Tasks (connect, check off, add), and study
// sessions with classmates.
(async function () {
  renderNav('classwork');
  await requireLogin();
  const { blockInfo, BLOCKS } = MHSBell;
  let info = null, sessions = [], data = null;

  // ---- messages after coming back from Google
  const MESSAGES = {
    connected: ['ok', 'Google Tasks is connected.'],
    denied: ['error', 'Google Tasks wasn\'t connected (you cancelled).'],
    scope: ['error', 'Google Tasks wasn\'t connected: tick the box that lets MHS Today see and edit your tasks, then try again.'],
    account: ['error', 'Connect the same Google account you sign in to MHS Today with.'],
    offline: ['error', 'Google didn\'t give MHS Today lasting access. Please try again.'],
    state: ['error', 'That attempt expired. Please try again.'],
    signin: ['error', 'Sign in again, then connect Google Tasks.'],
    busy: ['error', 'Too many people are connecting right now. Wait a minute and try again.'],
    failed: ['error', 'Something went wrong talking to Google. Please try again.']
  };
  const result = new URLSearchParams(location.search).get('tasks');
  if (result) {
    const [kind, text] = MESSAGES[result] || MESSAGES.failed;
    const box = $('tasks-msg');
    box.hidden = false;
    box.className = 'notice' + (kind === 'error' ? ' error' : '');
    box.textContent = text;
    history.replaceState(null, '', 'classwork.html');
  }

  // ---- Google Tasks
  function dueText(t, today) {
    if (!t.due) return null;
    if (t.due < today) return h('span', { class: 'bad' }, `Overdue · ${fmtRelativeDay(t.due, today)}`);
    return fmtDue(t.due, today);
  }
  function taskRow(t, today) {
    const box = h('input', { type: 'checkbox', 'aria-label': `Mark "${t.title}" done` });
    box.addEventListener('change', () => busy(box, async () => {
      await api('PUT', `/api/tasks/${encodeURIComponent(t.listId)}/${encodeURIComponent(t.id)}`, { done: box.checked });
      toast(box.checked ? 'Done!' : 'Marked not done');
      await loadTasks();
    }));
    const meta = [dueText(t, today), data.lists.length > 1 ? t.list : null].filter(Boolean);
    return h('div', { class: 'list-row' },
      h('label', { class: 'check' }, box, h('span', null,
        h('strong', null, t.title),
        meta.length ? h('span', { class: 'small muted', style: { display: 'block' } }, meta.flatMap((x, i) => (i ? [' · ', x] : [x]))) : null,
        t.notes ? h('span', { class: 'small', style: { display: 'block' } }, t.notes) : null)),
      t.link ? h('a', { class: 'small', href: t.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open') : null);
  }
  function renderTasks() {
    $('soon-card').hidden = data.available;
    $('tasks-intro').hidden = !data.available;
    $('connect-card').hidden = data.connected || !data.available;
    $('tasks-card').hidden = !data.connected;
    if (!data.connected) return;
    const today = schoolClock(info).date;
    fill($('tasks'), data.tasks.length ? data.tasks.map((t) => taskRow(t, today)) : h('p', { class: 'muted' }, 'Nothing to do. Nice!'));
    const current = $('tk-list').value;
    fill($('tk-list'), data.lists.map((l) => h('option', { value: l.id }, l.title)));
    if (current) $('tk-list').value = current;
  }
  async function loadTasks() {
    try {
      data = await api('GET', '/api/tasks');
    } catch (e) {
      if (e.status === 409) data = { available: true, connected: false }; // disconnected (revoked in Google)
      else { $('tasks-card').hidden = false; fill($('tasks'), h('p', { class: 'notice error' }, e.message)); return; }
    }
    renderTasks();
  }
  $('task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api('POST', '/api/tasks', { title: $('tk-title').value, due: $('tk-due').value || null, notes: $('tk-notes').value, listId: $('tk-list').value || null });
      $('tk-title').value = ''; $('tk-notes').value = '';
      $('tk-due').value = MHSCalendar.nextSchoolDay(info.calendar, schoolClock(info).date) || ''; // the usual: due next class day
      toast('Added to Google Tasks');
      await loadTasks();
      $('tk-title').focus(); // ready for the next one
    });
  });
  $('disconnect-btn').addEventListener('click', (e) => {
    if (!confirm('Disconnect Google Tasks? Your tasks stay in Google; MHS Today just stops showing them.')) return;
    busy(e.currentTarget, async () => { await api('DELETE', '/api/tasks/connection'); toast('Google Tasks disconnected'); await loadTasks(); });
  });

  // ---- study sessions
  function sessionRow(s, today) {
    const b = blockInfo(s.block);
    return h('div', { class: 'list-row' },
      h('div', null,
        h('strong', null, s.title),
        h('div', { class: 'small' }, colorDot(b && b.color), s.className, ' · ', fmtRelativeDay(s.date, today),
          s.time ? ` · ${MHSBell.formatTime(s.time)}` : '', s.place ? ` · ${s.place}` : ''),
        s.notes ? h('div', { class: 'small' }, s.notes) : null,
        h('div', { class: 'small muted' }, `${s.going} going: ${s.people.join(', ')}`)),
      h('div', { class: 'row nowrap' },
        h('button', {
          class: 'btn small' + (s.me ? ' secondary' : ''), type: 'button',
          onclick: (e) => busy(e.currentTarget, async () => { await api('POST', `/api/study/${s.id}/going`, { on: !s.me }); await loadSessions(); })
        }, s.me ? 'Not going' : "I'm going"),
        s.canDelete ? h('button', {
          class: 'linklike danger', type: 'button', 'aria-label': `Delete ${s.title}`,
          onclick: (e) => { if (confirm(`Delete "${s.title}"?`)) busy(e.currentTarget, async () => { await api('DELETE', `/api/study/${s.id}`); await loadSessions(); }); }
        }, 'Delete') : null));
  }
  async function loadSessions() {
    try {
      sessions = await api('GET', '/api/study');
      const today = schoolClock(info).date;
      fill($('sessions'), sessions.length ? sessions.map((s) => sessionRow(s, today)) : h('p', { class: 'muted small' }, 'No study sessions planned yet.'));
    } catch (e) {
      fill($('sessions'), h('p', { class: 'notice error' }, e.message));
    }
  }

  let classes;
  try {
    [classes, info] = await Promise.all([api('GET', '/api/classes'), loadCalendar()]);
  } catch (e) {
    fill($('tasks'), h('p', { class: 'notice error' }, e.message));
    return;
  }
  const mine = BLOCKS.filter((b) => classes[b.key]);
  $('no-classes').hidden = !!mine.length;
  $('study-card').hidden = !mine.length;
  fill($('st-block'), mine.map((b) => h('option', { value: b.key }, `${classes[b.key].name} (${b.label})`)));
  $('study-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api('POST', '/api/study', {
        block: $('st-block').value, title: $('st-title').value, date: $('st-date').value,
        time: $('st-time').value, place: $('st-place').value, notes: $('st-notes').value
      });
      e.target.reset();
      $('st-date').value = schoolClock(info).date;
      $('study-add').open = false;
      toast('Study session planned. Classmates can see it now.');
      await loadSessions();
    });
  });
  const today = schoolClock(info).date;
  $('st-date').min = today;
  $('st-date').value = today;
  $('tk-due').value = MHSCalendar.nextSchoolDay(info.calendar, today) || '';
  await Promise.all([loadTasks(), mine.length ? loadSessions() : null]);
})();
