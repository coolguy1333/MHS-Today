// Sign-in page: one button, friendly messages for everything that can go wrong.
(async function () {
  renderNav('login');
  const params = new URLSearchParams(location.search);
  const wanted = params.get('next') || '';
  const next = /^[a-z]+\.html(\?[A-Za-z0-9_=&.-]{0,100})?$/.test(wanted) ? wanted : 'index.html';
  const MESSAGES = {
    denied: 'Sign-in was cancelled.',
    state: 'That sign-in attempt expired. Please try again.',
    domain: "That Google account can't be used here.",
    unverified: "Google says that account's email address isn't verified.",
    failed: 'Something went wrong while talking to Google. Please try again.',
    config: 'Sign-in has not been set up yet. Ask the site owner.',
    busy: 'Too many people are signing in right now. Wait a minute and try again.',
    full: 'This site has reached its account limit.'
  };

  let me;
  try { me = await getMe(); } catch (e) {
    const box = $('login-error');
    box.hidden = false;
    box.textContent = e.message;
    return;
  }
  if (me.user) { location.replace(next); return; }

  const button = $('google-btn');
  button.href = '/auth/google?next=' + encodeURIComponent(next);
  const domains = me.config.allowedDomains;
  if (domains.length) $('login-hint').textContent = `Use your school Google account (${domains.map((d) => '@' + d).join(' or ')}).`;
  if (!me.config.signIn) {
    $('login-setup').hidden = false;
    button.removeAttribute('href');
    button.setAttribute('aria-disabled', 'true');
  }
  const code = params.get('error');
  if (code) {
    const box = $('login-error');
    box.hidden = false;
    box.textContent = MESSAGES[code] || MESSAGES.failed;
    if (code === 'domain' && domains.length) box.textContent += ` Use an account that ends in ${domains.map((d) => '@' + d).join(' or ')}.`;
  }
})();
