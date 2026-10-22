// Your profile, in sections: profile (name, avatar or photo, pronouns, grade, bio, interests), privacy,
// notifications and calendar sync, and your account (download your data, delete it). My classes is schedule.html.
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

  // ---- your own photo: placed and cropped here (a 256×256 JPEG), then waits for an admin
  function showPhoto(u) {
    const img = (src, alt) => h('img', { class: 'avatar photo', src, alt, width: '56', height: '56' });
    fill($('photo-status'), u.pendingPhoto
      ? [img(u.pendingPhoto, 'Your new photo'), h('span', { class: 'small' }, 'Waiting for an admin to approve it. Until then, people see ', u.photo ? 'your current photo.' : 'your avatar.')]
      : u.photo ? [img(u.photo, 'Your photo'), h('span', { class: 'small' }, 'Approved: people see this photo instead of your avatar.')]
        : h('span', { class: 'small muted' }, 'No photo: people see your avatar.'));
    $('photo-remove').hidden = !u.photo && !u.pendingPhoto;
  }
  // Crop: drag the photo to place it, zoom with the slider (or the mouse wheel / arrow keys), and see
  // the circle people will see. Resolves to a 256×256 JPEG data URL, or null if cancelled.
  function cropPhoto(bmp) {
    return new Promise((resolve) => {
      const P = 512; // canvas pixels (shown at about 280 CSS px)
      const canvas = h('canvas', { width: String(P), height: String(P), 'aria-hidden': 'true' });
      const ctx = canvas.getContext('2d');
      const cover = Math.max(P / bmp.width, P / bmp.height); // smallest scale that fills the square
      let zoom = 1, x = 0, y = 0; // the photo's top-left corner, in canvas pixels
      const size = () => [bmp.width * cover * zoom, bmp.height * cover * zoom];
      const clamp = () => { const [w, hh] = size(); x = Math.min(0, Math.max(P - w, x)); y = Math.min(0, Math.max(P - hh, y)); };
      const center = () => { const [w, hh] = size(); x = (P - w) / 2; y = (P - hh) / 2; };
      const draw = () => { clamp(); const [w, hh] = size(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, P, P); ctx.drawImage(bmp, x, y, w, hh); };
      // zoom around the middle of the square, so what's in the middle stays there
      const setZoom = (z) => {
        const before = size(), mid = P / 2;
        const fx = (mid - x) / before[0], fy = (mid - y) / before[1];
        zoom = Math.min(4, Math.max(1, z));
        const after = size();
        x = mid - fx * after[0]; y = mid - fy * after[1];
        slider.value = String(zoom);
        draw();
      };
      const slider = h('input', { type: 'range', min: '1', max: '4', step: '0.01', value: '1', 'aria-label': 'Zoom' });
      slider.addEventListener('input', () => setZoom(Number(slider.value)));
      const stage = h('div', { class: 'crop-stage', tabindex: '0', role: 'img', 'aria-label': 'Your photo. Drag, or use the arrow keys, to move it; + and − to zoom.' }, canvas);
      let drag = null;
      stage.addEventListener('pointerdown', (e) => { drag = { px: e.clientX, py: e.clientY, x, y }; stage.setPointerCapture(e.pointerId); stage.classList.add('dragging'); });
      stage.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const k = P / stage.getBoundingClientRect().width; // CSS px to canvas px
        x = drag.x + (e.clientX - drag.px) * k; y = drag.y + (e.clientY - drag.py) * k;
        draw();
      });
      const stop = () => { drag = null; stage.classList.remove('dragging'); };
      stage.addEventListener('pointerup', stop);
      stage.addEventListener('pointercancel', stop);
      stage.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }, { passive: false });
      stage.addEventListener('keydown', (e) => {
        const step = 16;
        const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (moves[e.key]) { x += moves[e.key][0]; y += moves[e.key][1]; draw(); }
        else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.1);
        else if (e.key === '-') setZoom(zoom / 1.1);
        else return;
        e.preventDefault();
      });
      const dlg = h('dialog', { class: 'dialog crop-dialog', 'aria-labelledby': 'crop-title' });
      const done = (value) => { dlg.close(); dlg.remove(); resolve(value); };
      add(dlg,
        h('div', { class: 'dialog-head' }, h('h2', { id: 'crop-title' }, 'Place your photo'),
          h('button', { class: 'linklike', type: 'button', 'aria-label': 'Close', onclick: () => done(null) }, '×')),
        h('p', { class: 'small muted' }, 'Drag to move it, and zoom so your face fills the circle.'),
        stage,
        h('label', { class: 'crop-zoom' }, h('span', { 'aria-hidden': 'true' }, '−'), slider, h('span', { 'aria-hidden': 'true' }, '+')),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn', type: 'button',
            onclick: () => {
              const out = document.createElement('canvas');
              out.width = out.height = 256;
              out.getContext('2d').drawImage(canvas, 0, 0, P, P, 0, 0, 256, 256);
              done(out.toDataURL('image/jpeg', 0.85));
            }
          }, 'Use this photo'),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => { center(); setZoom(1); center(); draw(); } }, 'Reset'),
          h('button', { class: 'linklike', type: 'button', onclick: () => done(null) }, 'Cancel')));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
      document.body.append(dlg);
      center(); draw();
      dlg.showModal();
      stage.focus();
    });
  }
  $('photo-file').addEventListener('change', (e) => {
    const file = e.currentTarget.files[0];
    if (!file) return;
    busy(null, async () => {
      if (!/^image\//.test(file.type)) throw new Error('Pick a photo (JPG or PNG).');
      let bmp;
      try { bmp = await createImageBitmap(file); } catch { throw new Error("That photo couldn't be opened. Try a JPG or PNG."); }
      const image = await cropPhoto(bmp);
      bmp.close();
      if (!image) return;
      const r = await api('POST', '/api/me/photo', { image });
      Object.assign(user, r);
      showPhoto(user);
      toast('Uploaded. An admin will take a look.');
    }).finally(() => { e.target.value = ''; });
  });
  $('photo-remove').addEventListener('click', (e) => {
    if (!confirm('Remove your photo?')) return;
    busy(e.currentTarget, async () => {
      await api('DELETE', '/api/me/photo');
      Object.assign(user, { photo: null, pendingPhoto: null });
      showPhoto(user);
      renderNav('account');
      toast('Photo removed');
    });
  });

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
    showPhoto(u);
    $('photo-file').disabled = !!u.profileLocked;
  }
  const countBio = () => { $('bio-count').textContent = `${Array.from($('bio').value).length}/160`; };
  $('bio').addEventListener('input', countBio);
  showProfile(user);
  // one section at a time: #profile (the default), #privacy, #alerts, #account
  const SECTIONS = isTeacher(user) ? ['profile', 'alerts', 'account'] : ['profile', 'privacy', 'alerts', 'account']; // teachers have no friends settings
  function showSection() {
    const key = SECTIONS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'profile';
    for (const k of SECTIONS) $(`sec-${k}`).hidden = k !== key;
    renderProfileHeader(user, key);
  }
  window.addEventListener('hashchange', () => { showSection(); window.scrollTo(0, 0); });
  showSection();
  $('share').checked = user.shareSchedule;
  $('searchable').checked = user.searchable;
  $('share-default').value = user.shareDefault;
  $('share-default').disabled = !user.shareSchedule;
  $('suggest-show').checked = user.suggest.show;
  $('suggest-friends').checked = user.suggest.viaFriends;
  $('suggest-classes').checked = user.suggest.viaClasses;
  const showHidden = () => {
    $('hidden-row').hidden = !user.hiddenSuggestions;
    $('hidden-count').textContent = `You hid ${user.hiddenSuggestions} ${user.hiddenSuggestions === 1 ? 'person' : 'people'} from your suggestions.`;
  };
  showHidden();
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
      showSection();
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
  $('share').addEventListener('change', (e) => { $('share-default').disabled = !e.currentTarget.checked; });
  autoSave('searchable', 'searchable', 'People can find you by name', 'You no longer show up in name search');

  const LEVELS = { full: 'classes + lunch', lunch: 'lunch only', none: 'nothing' };
  $('share-default').addEventListener('change', async (e) => {
    const select = e.currentTarget;
    try {
      Object.assign(user, await api('PUT', '/api/me', { shareDefault: select.value }));
      toast(`Friends now see ${LEVELS[select.value]} unless you picked something else for them`);
    } catch (err) {
      select.value = user.shareDefault;
      showError(err);
    }
  });
  // People you may know: each switch saves on its own
  for (const [id, key, onText, offText] of [
    ['suggest-show', 'show', 'You\'ll see people you may know', 'People you may know is hidden'],
    ['suggest-friends', 'viaFriends', 'Friends of your friends can see you as a suggestion', 'You won\'t be suggested to friends of your friends'],
    ['suggest-classes', 'viaClasses', 'People in your classes can see you as a suggestion', 'You won\'t be suggested to people in your classes']
  ]) {
    $(id).addEventListener('change', async (e) => {
      const box = e.currentTarget;
      try {
        Object.assign(user, await api('PUT', '/api/me', { suggest: { [key]: box.checked } }));
        toast(box.checked ? onText : offText);
      } catch (err) {
        box.checked = !box.checked;
        showError(err);
      }
    });
  }
  $('unhide').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    Object.assign(user, await api('DELETE', '/api/friends/suggestions/hidden'));
    showHidden();
    toast('People you hid can be suggested again');
  }));

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
