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
    ['index.html', 'Today', 'dashboard'], ['schedule.html', 'Schedule', 'schedule'], ['classwork.html', 'Classwork', 'classwork'],
    ['events.html', 'Events', 'events'], ['groups.html', 'Groups', 'groups'], ['lunch.html', 'Lunch', 'lunch'],
    ['friends.html', 'Friends', 'friends'], ['links.html', 'Links', 'links'], ['tools.html', 'Tools', 'tools']
  ];
  const auth = h('span', { class: 'nav-auth' });
  fill(nav,
    h('a', { href: 'index.html', class: 'brand' }, h('img', { src: 'icon-167.png', alt: '', width: '28', height: '28' }), 'MHS Hub'),
    h('nav', { 'aria-label': 'Main' },
      links.map(([href, label, key]) => h('a', { href, class: key === active ? 'active' : null, 'aria-current': key === active ? 'page' : null }, label)),
      auth)
  );
  getMe().then((me) => {
    if (me.user) {
      add(auth,
        me.user.admin ? h('a', { href: 'admin.html', class: active === 'admin' ? 'active' : null }, 'Admin') : null,
        h('a', { href: 'account.html', class: 'nav-me' + (active === 'account' ? ' active' : '') }, avatarEl(me.user, 22), me.user.name),
        h('button', {
          class: 'linklike', type: 'button',
          onclick: async () => {
            await forgetThisDevice(); // before signing out: removing the subscription needs the session
            try { await api('POST', '/api/logout', {}); } finally {
              await clearOfflineCopy();
              location.href = 'index.html';
            }
          }
        }, 'Sign out')
      );
    } else {
      add(auth, h('a', { href: 'login.html' }, 'Sign in'));
    }
  }).catch(() => {});
  renderBanner(nav);
}

// Admins' announcements, under the nav on every page. A closed one stays closed on this device.
function renderBanner(nav) {
  let closed = [];
  try { closed = JSON.parse(localStorage.getItem('mhs-closed-notices') || '[]'); } catch { /* storage blocked */ }
  api('GET', '/api/notices').then(({ announcements }) => {
    const show = announcements.filter((a) => !closed.includes(a.id));
    if (!show.length) return;
    const box = h('div', { class: 'banners', role: 'region', 'aria-label': 'Announcements' }, show.map((a) => {
      const el = h('div', { class: 'banner' + (a.urgent ? ' urgent' : '') }, h('span', null, a.text),
        h('button', {
          class: 'linklike', type: 'button', 'aria-label': 'Hide this announcement',
          onclick: () => {
            el.remove();
            try { localStorage.setItem('mhs-closed-notices', JSON.stringify([...closed, a.id].slice(-50))); } catch { /* storage blocked */ }
          }
        }, '×'));
      return el;
    }));
    nav.after(box);
  }).catch(() => {});
}

// ---- installable app ----------------------------------------------------------------
// The service worker keeps an offline copy of the pages (and your schedule) and shows push notifications.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
// Stops this device's push notifications for the signed-in person (so a shared phone doesn't keep
// getting someone else's reminders after they sign out).
async function forgetThisDevice() {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    await api('DELETE', '/api/push/subscribe?endpoint=' + encodeURIComponent(sub.endpoint)).catch(() => {});
    await sub.unsubscribe();
  } catch { /* push isn't available here */ }
}
async function clearOfflineCopy() {
  try { if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k); } catch { /* nothing cached */ }
}
const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
const KIND_NAMES = { assignment: 'Assignment', quiz: 'Quiz', test: 'Test' };
const GROUP_KINDS = { club: 'Club', sport: 'Sport', group: 'Student group' };

// ---- classes and friends -------------------------------------------------------
// Same class = same name, and the same teacher (by last name) when both have one. Shared with the server.
const sameClass = (a, b) => MHSBell.sameClass(a, b);
// Classes are saved per color block; the day letter picks the block for each hour.
function classAt(classes, letter, hour) {
  const key = MHSBell.blockFor(letter, hour);
  return key && classes && Object.prototype.hasOwnProperty.call(classes, key) ? classes[key] : null;
}
// What is a friend doing in `hour` on day `letter`? -> { text, muted }
function friendClassText(friend, letter, hour) {
  if (!friend.classes) return { text: 'Schedule hidden', muted: true };
  if (hour === 'advisory') return { text: 'Advisory', muted: false };
  const c = classAt(friend.classes, letter, hour);
  if (!c) return { text: 'No class set', muted: true };
  return { text: c.name + (c.room ? ` · Rm ${c.room}` : ''), muted: false };
}
// A friend's lunch ('A' | 'B' | 'C' | null) on a day letter. Friends who share only their lunch
// send `lunches` ({ A: 'B', ... }) instead of their classes.
function friendLunch(friend, letter) {
  if (friend.lunches) return Object.prototype.hasOwnProperty.call(friend.lunches, letter) ? friend.lunches[letter] : null;
  return MHSBell.lunchFor(friend.classes, letter);
}
// "Same lunch as you (B)" etc. for a day letter, or null when either lunch is unknown.
function sharedLunchText(myClasses, friend, letter) {
  if (!letter) return null;
  const mine = MHSBell.lunchFor(myClasses, letter);
  const theirs = friendLunch(friend, letter);
  if (!theirs) return null;
  if (!mine) return { text: `${theirs} Lunch`, same: false };
  return { text: mine === theirs ? `Same lunch as you (${theirs})` : `${theirs} Lunch`, same: mine === theirs };
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
  if (!friend.classes && !friend.lunches) return { text: 'Schedule hidden', muted: true };
  if (live.status === 'no-school') return { text: 'No school today', muted: true };
  if (live.status === 'before-school') return { text: "School hasn't started", muted: true };
  if (live.status === 'after-school') return { text: "School's out", muted: true };
  if (live.status === 'passing') return { text: 'Passing period', muted: true };
  if (live.cur.period.hour === MHSBell.LUNCH_HOUR) {
    const lunch = friendLunch(friend, live.day.dayLetter);
    if (MHSBell.atLunch(live.day.scheduleType, lunch, live.now.minutes)) return { text: `At ${lunch} Lunch`, muted: false };
  }
  if (!friend.classes) return { text: 'Shares lunch only', muted: true };
  return friendClassText(friend, live.day.dayLetter, live.cur.period.hour);
}
// One event in a list: when, who can see it, its group, the sign-up list, and delete for organizers.
// `reload` runs after a change.
function eventRow(e, today, reload) {
  const VIS = { group: 'Group members', private: 'Private' };
  const s = e.signup;
  const signupLine = s ? h('div', { class: 'signup-line small' },
    h('span', { class: 'muted' }, s.limit ? `${s.count} of ${s.limit} signed up` : `${s.count} signed up`),
    e.by === undefined ? h('a', { href: 'login.html?next=events.html' }, 'Sign in to sign up') : h('button', {
      class: 'btn small' + (s.me ? ' secondary' : ''), type: 'button', disabled: !s.me && s.limit > 0 && s.count >= s.limit,
      onclick: (ev) => busy(ev.currentTarget, async () => {
        await api('POST', `/api/events/${e.id}/signup`, { on: !s.me });
        toast(s.me ? 'Taken off the list' : "You're signed up");
        await reload();
      })
    }, s.me ? 'Cancel my spot' : s.limit > 0 && s.count >= s.limit ? 'Full' : 'Sign up'),
    s.people && s.people.length ? h('span', { class: 'muted' }, `· ${s.people.map((p) => p.name).join(', ')}`) : null) : null;
  return h('div', { class: 'list-row' },
    h('div', null,
      h('strong', null, e.title), VIS[e.visibility] ? [' ', h('span', { class: 'badge vis' }, VIS[e.visibility])] : null,
      h('div', { class: 'small muted' },
        fmtRelativeDay(e.date, today) + (e.time ? ` · ${MHSBell.formatTime(e.time)}` : ''),
        e.group ? [' · ', h('a', { href: `group.html?id=${encodeURIComponent(e.group.id)}` }, e.group.name)] : null,
        e.by ? ` · added by ${e.by}` : ''),
      e.description ? h('div', { class: 'small' }, e.description) : null,
      e.invitees && e.invitees.length ? h('div', { class: 'small muted' }, `Invited: ${e.invitees.map((p) => p.name).join(', ')}`) : null,
      signupLine),
    e.mine ? h('button', {
      class: 'linklike danger', type: 'button', 'aria-label': `Delete ${e.title}`,
      onclick: (ev) => busy(ev.currentTarget, async () => {
        if (!confirm(`Delete "${e.title}"?`)) return;
        await api('DELETE', '/api/events/' + e.id);
        toast('Event deleted');
        await reload();
      })
    }, 'Delete') : null);
}

// A round avatar: the person's emoji, or their initials, on their color.
function avatarEl(person, size = 32) {
  const a = MHSAvatars.clean(person && person.avatar);
  return h('span', {
    class: 'avatar', 'aria-hidden': 'true',
    style: { background: MHSAvatars.COLORS[a.color], width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * (a.emoji ? 0.55 : 0.4))}px` }
  }, a.emoji || MHSAvatars.initials(person && person.name));
}
const gradeText = (g) => (g ? `${g}th grade` : null);
// A friend's profile in a pop-up: avatar, name, pronouns, grade, bio, interests.
function showProfileCard(p) {
  const close = h('button', { class: 'btn small secondary', type: 'button' }, 'Close');
  const dlg = h('dialog', { class: 'profile-card', 'aria-label': `${p.name}'s profile` },
    h('div', { class: 'profile-head' }, avatarEl(p, 64),
      h('div', null, h('h2', null, p.name),
        h('div', { class: 'muted' }, [p.pronouns, gradeText(p.grade)].filter(Boolean).join(' · ') || null))),
    p.bio ? h('p', null, p.bio) : null,
    p.interests && p.interests.length ? h('div', { class: 'chips' }, p.interests.map((i) => h('span', { class: 'chip' }, i))) : null,
    !p.bio && !(p.interests && p.interests.length) ? h('p', { class: 'muted small' }, "They haven't filled in their profile yet.") : null,
    h('div', { class: 'row' }, close));
  close.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click outside the card
  document.body.append(dlg);
  dlg.showModal();
}
function colorDot(color) {
  const d = h('span', { class: 'dot', 'aria-hidden': 'true' });
  if (/^#[0-9a-fA-F]{6}$/.test(color || '')) d.style.background = color;
  return d;
}
