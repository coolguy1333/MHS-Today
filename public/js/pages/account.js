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

  const confirmBox = $('confirm-delete');
  confirmBox.addEventListener('input', () => { $('delete-btn').disabled = confirmBox.value.trim().toUpperCase() !== 'DELETE'; });
  $('delete-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (confirmBox.value.trim().toUpperCase() !== 'DELETE') return;
    busy($('delete-btn'), async () => {
      await api('DELETE', '/api/me');
      location.href = 'index.html';
    });
  });
})();
