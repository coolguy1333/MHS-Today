// Shared helpers for every page (plain script: these functions are globals).
// Pages build their DOM with h() and never put untrusted text through innerHTML.

// ---- talking to the server ----------------------------------------------------
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'X-Requested-With': 'mhs', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
  } catch (e) {
    const err = new Error("Can't reach the server. Check your connection and try again.");
    err.network = true;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty or non-JSON body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Something went wrong (${res.status})`);
    err.status = res.status;
    if (res.status === 401) goToLogin(); // session ended: sign in again and come back here
    throw err;
  }
  return data;
}

function goToLogin() {
  const page = location.pathname.split('/').pop() || 'index.html';
  const next = /^[a-z]+\.html$/.test(page) ? page + (/^\?[A-Za-z0-9_=&.-]{0,100}$/.test(location.search) ? location.search : '') : 'index.html';
  location.href = 'login.html?next=' + encodeURIComponent(next);
}

// ---- building DOM safely -------------------------------------------------------
// h('a', { href: '/x', class: 'btn', onclick: fn, dataset: { id: 1 } }, 'text', childNode, [more])
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v); // via the CSS object model, which the CSP allows
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  return add(el, children);
}
// Appends strings (as text, never markup), nodes, and nested arrays of them; skips null/false.
// Use this instead of el.append(), which would turn null and arrays into the text "null" / "[object ...]".
function add(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
function clear(el) { el.replaceChildren(); return el; }
function fill(el, ...children) { return add(clear(el), children); }
function $(id) { return document.getElementById(id); }

function toast(message, kind) {
  let box = $('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
    add(document.body, box);
  }
  const t = h('div', { class: 'toast' + (kind === 'error' ? ' error' : '') }, message);
  add(box, t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 2800);
}
const showError = (e) => toast(e && e.message ? e.message : 'Something went wrong', 'error');

// Runs an async click/submit handler with the button disabled, reporting any error as a toast.
async function busy(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); } catch (e) { showError(e); } finally { if (button) button.disabled = false; }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const box = h('input', { value: text, readonly: true, class: 'sr-only', 'aria-hidden': 'true' });
    add(document.body, box);
    box.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* fall through */ }
    box.remove();
    if (!ok) { toast("Couldn't copy automatically. Select it and press Ctrl+C.", 'error'); return false; }
  }
  toast('Copied');
  return true;
}

// ---- who is signed in ----------------------------------------------------------
let mePromise = null;
function getMe() { // { user | null, config }
  if (!mePromise) mePromise = api('GET', '/api/me').catch((e) => { mePromise = null; throw e; }); // don't cache a failure
  return mePromise;
}
async function requireLogin() {
  const me = await getMe();
  if (!me.user) { goToLogin(); await new Promise(() => {}); }
  return me.user;
}

function renderNav(active) {
  const nav = $('site-nav');
  if (!nav) return;
  const links = [
    ['index.html', 'Today', 'dashboard'], ['schedule.html', 'My Schedule', 'schedule'], ['events.html', 'Events', 'events'],
    ['friends.html', 'Friends', 'friends'], ['tools.html', 'Tools', 'tools']
  ];
  const auth = h('span', { class: 'nav-auth' });
  fill(nav,
    h('a', { href: 'index.html', class: 'brand' }, '\u{1F40E} MHS Hub'),
    h('nav', { 'aria-label': 'Main' },
      links.map(([href, label, key]) => h('a', { href, class: key === active ? 'active' : null, 'aria-current': key === active ? 'page' : null }, label)),
      auth)
  );
  getMe().then((me) => {
    if (me.user) {
      add(auth,
        me.user.admin ? h('a', { href: 'admin.html', class: active === 'admin' ? 'active' : null }, 'Admin') : null,
        h('a', { href: 'account.html', class: active === 'account' ? 'active' : null }, me.user.name),
        h('button', {
          class: 'linklike', type: 'button',
          onclick: async () => { try { await api('POST', '/api/logout', {}); } finally { location.href = 'index.html'; } }
        }, 'Sign out')
      );
    } else {
      add(auth, h('a', { href: 'login.html' }, 'Sign in'));
    }
  }).catch(() => {});
}

// ---- calendar and time ---------------------------------------------------------
let calendarPromise = null;
// { tz, calendar, offset } - `offset` corrects for a wrong clock on the student's device.
function loadCalendar(force) {
  if (!calendarPromise || force) {
    calendarPromise = api('GET', '/api/calendar')
      .then((d) => ({ tz: d.tz, calendar: d.calendar, offset: d.serverTime - Date.now() }))
      .catch((e) => { calendarPromise = null; throw e; });
  }
  return calendarPromise;
}
function schoolClock(info) { return MHSCalendar.schoolNow(info.tz, new Date(Date.now() + info.offset)); } // { date, minutes }

const utcDate = (dateStr) => new Date(MHSCalendar.parseDate(dateStr));
const fmtLongDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(utcDate(d));
const fmtShortDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(utcDate(d));
function fmtRelativeDay(d, today) {
  if (d === today) return 'Today';
  if (d === MHSCalendar.addDays(today, 1)) return 'Tomorrow';
  if (d === MHSCalendar.addDays(today, -1)) return 'Yesterday';
  return fmtShortDay(d);
}
function fmtMinutes(mins) {
  const n = Math.max(1, Math.ceil(mins));
  const hrs = Math.floor(n / 60);
  return hrs ? `${hrs} h ${n % 60} min` : `${n} min`;
}
const SCHEDULE_NAMES = { daily: 'Daily schedule', advisory: 'Advisory day', early_release: 'Early release' };

// ---- classes and friends -------------------------------------------------------
const normClass = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Same class = same name, and the same teacher when both have one.
function sameClass(a, b) {
  if (!a || !b) return false;
  if (normClass(a.name) !== normClass(b.name)) return false;
  const ta = normClass(a.teacher), tb = normClass(b.teacher);
  return !ta || !tb || ta === tb;
}
// What is a friend doing in `hour` on day `letter`? -> { text, muted }
function friendClassText(friend, letter, hour) {
  if (!friend.classes) return { text: 'Schedule hidden', muted: true };
  if (hour === 'advisory') return { text: 'Advisory', muted: false };
  const c = letter && friend.classes[`${letter}_${hour}`];
  if (!c) return { text: 'No class set', muted: true };
  return { text: c.name + (c.room ? ` · Rm ${c.room}` : ''), muted: false };
}
// What is happening at school right now? -> { now, day, status, cur? }
// status: 'no-school' | 'before-school' | 'in-class' | 'passing' | 'after-school'
function liveState(info) {
  const now = schoolClock(info);
  const day = MHSCalendar.dayInfo(info.calendar, now.date);
  if (!day.schoolDay) return { now, day, status: 'no-school' };
  const cur = MHSBell.getCurrentPeriod(day.scheduleType, now.minutes);
  return { now, day, cur, status: cur.status };
}
function friendNowText(friend, live) {
  if (!friend.classes) return { text: 'Schedule hidden', muted: true };
  if (live.status === 'no-school') return { text: 'No school today', muted: true };
  if (live.status === 'before-school') return { text: "School hasn't started", muted: true };
  if (live.status === 'after-school') return { text: "School's out", muted: true };
  if (live.status === 'passing') return { text: 'Passing period', muted: true };
  return friendClassText(friend, live.day.dayLetter, live.cur.period.hour);
}
function colorDot(color) {
  const d = h('span', { class: 'dot', 'aria-hidden': 'true' });
  if (/^#[0-9a-fA-F]{6}$/.test(color || '')) d.style.background = color;
  return d;
}
