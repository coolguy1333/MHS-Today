// Privacy & Terms. Opened with ?agree=1 (first sign-in, or after the terms change): agree at the
// bottom to carry on to the page you were going to, or sign out.
(async function () {
  renderNav('terms');
  const params = new URLSearchParams(location.search);
  let me = null;
  try { me = (await getMe()).user; } catch { /* the page still reads fine */ }
  $('export-link').hidden = !me;
  if (!me || !me.mustAgree) return;
  $('agree-card').hidden = false;
  document.body.classList.add('agreeing'); // nothing else to go to until they agree
  $('agree-bottom').hidden = false;
  // a new account also says whether it's a student or a teacher
  const pickRole = me.role === null;
  $('role-pick').hidden = !pickRole;
  const role = () => { const r = document.querySelector('input[name="role"]:checked'); return r ? r.value : null; };
  const sync = () => { $('agree-btn').disabled = !$('agree-box').checked || (pickRole && !role()); };
  $('agree-box').addEventListener('change', sync);
  for (const r of document.querySelectorAll('input[name="role"]')) r.addEventListener('change', sync);
  $('agree-btn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await api('POST', '/api/me/agree', { version: me.termsVersion, ...(pickRole ? { role: role() } : {}) });
    const next = params.get('next');
    location.href = next && /^[a-z]+\.html(\?[A-Za-z0-9_=&.%-]{0,200})?$/.test(next) && !next.startsWith('terms.html') ? next : 'index.html';
  }));
  $('decline-btn').addEventListener('click', () => signOut());
})();
