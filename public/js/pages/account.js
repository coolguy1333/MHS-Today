// Account: profile (name, avatar, pronouns, grade, bio, interests), privacy switches, delete account.
(async function () {
  renderNav('account');
  const user = await requireLogin();
  // Avatar picker: a color, and an emoji or "initials".
  const { COLORS, EMOJIS } = MHSAvatars;
  const choice = (group, value, label, face) => h('label', { title: label },
    h('input', { type: 'radio', name: group, value, 'aria-label': label }), face);
  add($('color-picker'), Object.entries(COLORS).map(([key, hex]) =>
    choice('avatar-color', key, `${key[0].toUpperCase()}${key.slice(1)}`, h('span', { class: 'swatch', style: { background: hex } }))));
  add($('emoji-picker'), choice('avatar-emoji', '', 'Initials', h('span', { class: 'emoji small' }, 'Aa')),
    EMOJIS.map((e) => choice('avatar-emoji', e, e, h('span', { class: 'emoji' }, e))));
  const picked = (group) => (document.querySelector(`input[name="${group}"]:checked`) || {}).value;
  const currentAvatar = () => ({ color: picked('avatar-color') || 'blue', emoji: picked('avatar-emoji') || '' });
  const preview = () => fill($('avatar-preview'), avatarEl({ name: $('name').value, avatar: currentAvatar() }, 48),
    h('span', { class: 'muted small' }, 'This is how friends see you.'));
  for (const id of ['color-picker', 'emoji-picker', 'name']) $(id).addEventListener('input', preview);
  const interestsOf = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

  function showProfile(u) {
    $('name').value = u.name;
    $('grade').value = u.grade ? String(u.grade) : '';
    $('bio').value = u.bio || '';
    $('pronouns').value = u.pronouns || '';
    $('interests').value = (u.interests || []).join(', ');
    const a = MHSAvatars.clean(u.avatar);
    document.querySelector(`input[name="avatar-color"][value="${a.color}"]`).checked = true;
    for (const r of document.querySelectorAll('input[name="avatar-emoji"]')) r.checked = r.value === a.emoji;
    $('locked-note').hidden = !u.profileLocked;
    for (const el of $('profile-form').querySelectorAll('input, select, textarea, button')) el.disabled = !!u.profileLocked;
    countBio();
    preview();
  }
  const countBio = () => { $('bio-count').textContent = `${Array.from($('bio').value).length}/160`; };
  $('bio').addEventListener('input', countBio);
  showProfile(user);
  $('share').checked = user.shareSchedule;
  $('searchable').checked = user.searchable;
  $('admin-card').hidden = !user.admin;

  $('profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const interests = interestsOf($('interests').value);
      if (interests.length > 5) throw new Error('Pick up to 5 interests.');
      const updated = await api('PUT', '/api/me', {
        name: $('name').value, grade: $('grade').value || null, bio: $('bio').value,
        pronouns: $('pronouns').value, interests, avatar: currentAvatar()
      });
      Object.assign(user, updated);
      showProfile(updated);
      renderNav('account');
      toast('Profile saved');
    });
  });

  // A switch that saves as soon as it changes, and flips back if the server says no.
  function autoSave(id, field, onText, offText) {
    $(id).addEventListener('change', async (e) => {
      const box = e.currentTarget;
      try {
        const updated = await api('PUT', '/api/me', { [field]: box.checked });
        user[field] = updated[field];
        toast(box.checked ? onText : offText);
      } catch (err) {
        box.checked = !box.checked;
        showError(err);
      }
    });
  }
  autoSave('share', 'shareSchedule', 'Friends can see your schedule', 'Your schedule is hidden from all friends');
  autoSave('searchable', 'searchable', 'People can find you by name', 'You no longer show up in name search');

  // ---- notifications (per device)
  const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  async function currentSub() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function renderNotify() {
    const body = $('notify-body');
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!supported) {
      $('notify-prefs').hidden = true;
      fill(body, isIos() && !isInstalled()
        ? [h('p', null, 'On iPhone, notifications work once MHS Today is on your home screen:'),
          h('ol', { class: 'small' }, h('li', null, 'In Safari, tap the Share button (the square with an arrow).'),
            h('li', null, 'Tap ', h('strong', null, 'Add to Home Screen'), ', then ', h('strong', null, 'Add'), '.'),
            h('li', null, 'Open MHS Today from your home screen and come back to this page.'))]
        : h('p', { class: 'muted' }, "This browser can't show notifications from websites."));
      return;
    }
    const info = await api('GET', '/api/push');
    const sub = await currentSub();
    const on = !!sub && Notification.permission === 'granted';
    $('notify-prefs').hidden = !info.devices;
    for (const box of $('notify-prefs').querySelectorAll('input')) box.checked = info.prefs[box.dataset.kind];
    // assignment reminders come from Google Tasks, which may still be "coming soon"
    $('notify-prefs').querySelector('[data-kind="classwork"]').closest('label').hidden = !(await getMe()).config.assignments;
    fill(body,
      h('p', null, on ? 'Notifications are on for this device.' : Notification.permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser or phone settings, then come back.'
        : 'Get reminders on this device.'),
      info.devices && !on ? h('p', { class: 'small muted' }, `On for ${info.devices} other device${info.devices === 1 ? '' : 's'}.`) : null,
      h('div', { class: 'row' },
        on ? null : h('button', {
          class: 'btn small', type: 'button', disabled: Notification.permission === 'denied',
          onclick: (e) => busy(e.currentTarget, async () => {
            if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not allowed.');
            const reg = await navigator.serviceWorker.ready;
            const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(info.publicKey) });
            await api('POST', '/api/push/subscribe', s.toJSON());
            toast('Notifications are on');
            await renderNotify();
          })
        }, 'Turn on notifications'),
        on ? h('button', {
          class: 'btn small secondary', type: 'button',
          onclick: (e) => busy(e.currentTarget, async () => { await api('POST', '/api/push/test', {}); toast('Sent. It should show up in a few seconds.'); })
        }, 'Send a test') : null,
        on ? h('button', {
          class: 'linklike', type: 'button',
          onclick: (e) => busy(e.currentTarget, async () => {
            await api('DELETE', `/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`);
            await sub.unsubscribe();
            toast('Notifications are off for this device');
            await renderNotify();
          })
        }, 'Turn off on this device') : null));
  }
  for (const box of $('notify-prefs').querySelectorAll('input')) {
    box.addEventListener('change', () => busy(box, async () => {
      try { await api('PUT', '/api/push/prefs', { [box.dataset.kind]: box.checked }); } catch (err) { box.checked = !box.checked; throw err; }
    }));
  }
  renderNotify().catch((e) => fill($('notify-body'), h('p', { class: 'notice error' }, e.message)));

  // ---- calendar sync
  async function renderCalendar(url) {
    const box = $('cal-body');
    if (!url) {
      fill(box, h('button', {
        class: 'btn small', type: 'button',
        onclick: (e) => busy(e.currentTarget, async () => renderCalendar((await api('POST', '/api/me/calendar', {})).url))
      }, 'Get my calendar link'));
      return;
    }
    const webcal = url.replace(/^https?:/, 'webcal:');
    const field = h('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Your private calendar link' });
    fill(box,
      h('div', { class: 'row' },
        h('a', { class: 'btn small', href: webcal }, 'Add to iPhone / Mac calendar'),
        // Google gets the https link: given webcal:// it fetches over plain http, sending the private link unencrypted.
        h('a', { class: 'btn small secondary', href: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Add to Google Calendar')),
      h('details', { class: 'small' }, h('summary', null, 'Using Google Calendar?'),
        h('ul', null,
          h('li', null, 'Add it on a computer: the Google Calendar phone app can\'t add calendars from a link. Use the button above, or on ',
            h('a', { href: 'https://calendar.google.com/calendar/r/settings/addbyurl', target: '_blank', rel: 'noopener noreferrer' }, 'calendar.google.com'),
            ' choose ', h('em', null, 'Other calendars → + → From URL'), ' and paste the link below.'),
          h('li', null, 'It then shows up in the Google Calendar app on your phone (if not, open the app\'s settings and turn on sync for "MHS Today").'),
          h('li', null, 'Google checks for changes every few hours, so new classwork or events can take a while to appear. Apple Calendar updates more often.'))),
      h('label', { class: 'stack small' }, h('span', null, 'Or copy the link into any calendar app ("subscribe" or "add from URL"):'),
        h('span', { class: 'inline-field' }, field, h('button', { class: 'btn small secondary', type: 'button', onclick: () => copyText(url) }, 'Copy'))),
      h('p', { class: 'small muted' }, 'Keep this link private: anyone with it can see what is in it. ',
        h('button', {
          class: 'linklike', type: 'button',
          onclick: (e) => { if (confirm('Make a new link? The old one stops working, so calendars using it stop updating.')) busy(e.currentTarget, async () => renderCalendar((await api('POST', '/api/me/calendar', {})).url)); }
        }, 'Make a new link'), ' · ',
        h('button', {
          class: 'linklike danger', type: 'button',
          onclick: (e) => busy(e.currentTarget, async () => { await api('DELETE', '/api/me/calendar'); toast('Calendar link turned off'); renderCalendar(null); })
        }, 'Turn off')));
  }
  api('GET', '/api/me/calendar').then((r) => renderCalendar(r.url)).catch((e) => fill($('cal-body'), h('p', { class: 'notice error' }, e.message)));

  const confirmBox = $('confirm-delete');
  confirmBox.addEventListener('input', () => { $('delete-btn').disabled = confirmBox.value.trim().toUpperCase() !== 'DELETE'; });
  $('delete-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (confirmBox.value.trim().toUpperCase() !== 'DELETE') return;
    busy($('delete-btn'), async () => {
      await forgetThisDevice();
      await api('DELETE', '/api/me');
      await clearOfflineCopy(); // the device's offline copy has this person's schedule and friends
      location.href = 'index.html';
    });
  });
})();
