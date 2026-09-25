// Shared helpers: all state is stored per-browser in localStorage.
// No accounts, no server — this is a static site "for now".

const STORE_KEYS = {
  classes: 'mhs_classes', // { "A_1": {name, teacher, room, color}, ... }
  today: 'mhs_today', // { scheduleType, dayLetter }
  events: 'mhs_events' // [ {id, title, date, time, description} ]
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getClasses() { return loadJSON(STORE_KEYS.classes, {}); }
function saveClasses(obj) { saveJSON(STORE_KEYS.classes, obj); }

function getToday() { return loadJSON(STORE_KEYS.today, { scheduleType: 'daily', dayLetter: 'A' }); }
function saveToday(val) { saveJSON(STORE_KEYS.today, val); }

function getEvents() {
  const stored = loadJSON(STORE_KEYS.events, null);
  if (stored) return stored;
  // Seed a couple of placeholder events on first visit
  const seeded = [
    { id: cryptoId(), title: 'Homecoming Week', date: '2026-09-28', time: '', description: 'Spirit week and Homecoming events at MHS.' },
    { id: cryptoId(), title: 'Check the official MHS calendar', date: '2026-09-24', time: '', description: 'Add real events here, or see masd.k12.wi.us/Calendar for the official one.' }
  ];
  saveJSON(STORE_KEYS.events, seeded);
  return seeded;
}
function saveEvents(list) { saveJSON(STORE_KEYS.events, list); }

function cryptoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
    </nav>
  `;
}
