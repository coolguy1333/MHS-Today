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
  $('agree-bottom').hidden = false;
  $('agree-box').addEventListener('change', () => { $('agree-btn').disabled = !$('agree-box').checked; });
  $('agree-btn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await api('POST', '/api/me/agree', { version: me.termsVersion });
    const next = params.get('next');
    location.href = next && /^[a-z]+\.html(\?[A-Za-z0-9_=&.%-]{0,200})?$/.test(next) && !next.startsWith('terms.html') ? next : 'index.html';
  }));
  $('decline-btn').addEventListener('click', () => signOut());
})();
