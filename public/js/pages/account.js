// Account: profile (name, grade, bio), privacy switches, delete account.
(async function () {
  renderNav('account');
  const user = await requireLogin();
  function showProfile(u) {
    $('name').value = u.name;
    $('grade').value = u.grade ? String(u.grade) : '';
    $('bio').value = u.bio || '';
    $('locked-note').hidden = !u.profileLocked;
    for (const id of ['name', 'grade', 'bio', 'profile-save']) $(id).disabled = !!u.profileLocked;
    countBio();
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
      const updated = await api('PUT', '/api/me', { name: $('name').value, grade: $('grade').value || null, bio: $('bio').value });
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
