// Shared helpers: talks to the MHS Hub server (see server.js).

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Requested-With': 'mhs', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

let mePromise = null;
function getMe() {
  if (!mePromise) mePromise = api('GET', '/api/me').catch(() => ({ user: null, registration: false }));
  return mePromise;
}
// Resolve to the signed-in user, or send the visitor to the login page.
async function requireLogin() {
  const me = await getMe();
  if (!me.user) {
    location.href = 'login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() || 'index.html');
    return new Promise(() => {});
  }
  return me.user;
}

function renderNav(active) {
  const links = [
    { href: 'index.html', label: 'Dashboard', key: 'dashboard' },
    { href: 'schedule.html', label: 'My Schedule', key: 'schedule' },
    { href: 'events.html', label: 'Events', key: 'events' },
    { href: 'tools.html', label: 'Tools', key: 'tools' },
    { href: 'friends.html', label: 'Friends', key: 'friends' }
  ];
  const nav = document.getElementById('site-nav');
  if (!nav) return;
  nav.innerHTML = `
    <a href="index.html" class="brand">🐎 MHS Hub</a>
    <nav>
      ${links.map(l => `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`).join('')}
      <span id="nav-auth"></span>
    </nav>
  `;
  getMe().then(me => {
    const el = document.getElementById('nav-auth');
    if (me.user) {
      el.innerHTML = `<span class="small">${escapeHtml(me.user.username)}</span> <button class="linklike" id="logout-btn">Sign out</button>`;
      document.getElementById('logout-btn').addEventListener('click', async () => {
        await api('POST', '/api/logout', {});
        location.href = 'index.html';
      });
    } else {
      el.innerHTML = `<a href="login.html">Sign in</a>`;
    }
  });
}
