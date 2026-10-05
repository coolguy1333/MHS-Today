// Account: display name, privacy switch, delete account.
(async function () {
  renderNav('account');
  const user = await requireLogin();
  $('name').value = user.name;
  $('share').checked = user.shareSchedule;
  $('admin-card').hidden = !user.admin;

  $('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const updated = await api('PUT', '/api/me', { name: $('name').value });
      user.name = updated.name;
      $('name').value = updated.name;
      renderNav('account');
      toast('Saved');
    });
  });

  $('share').addEventListener('change', async (e) => {
    const box = e.currentTarget;
    try {
      const updated = await api('PUT', '/api/me', { shareSchedule: box.checked });
      user.shareSchedule = updated.shareSchedule;
      toast(box.checked ? 'Friends can see your classes' : 'Your classes are hidden from friends');
    } catch (err) {
      box.checked = !box.checked; // put it back: the server didn't accept the change
      showError(err);
    }
  });

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
