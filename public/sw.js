// Service worker: an offline copy of the site (pages, styles, your schedule) and push notifications.
// Everything goes to the network first; the copy is only used when there is no connection.
// Signing out clears the copy (see clearOfflineCopy in js/app.js).
'use strict';
const CACHE = 'mhs-today-v1';
const SHELL = [
  '/index.html', '/schedule.html', '/classwork.html', '/lunch.html', '/events.html', '/offline.html',
  '/css/style.css', '/js/app.js', '/js/calendar.js', '/js/bellSchedule.js', '/js/avatars.js',
  '/js/pages/index.js', '/js/pages/schedule.js', '/js/pages/classwork.js', '/js/pages/lunch.js', '/js/pages/events.js',
  '/icon-32.png', '/icon-167.png', '/app-icon-192.png'
];
// API answers worth keeping for offline use (all about the signed-in person or the school day).
const KEEP_API = ['/api/me', '/api/calendar', '/api/classes', '/api/tasks', '/api/notices', '/api/events', '/api/friends', '/api/lunch', '/api/study'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/cal/')) return;
  const isApi = url.pathname.startsWith('/api/');
  if (isApi && !KEEP_API.includes(url.pathname)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: !isApi });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match('/offline.html')) || Response.error();
      throw err;
    }
  })());
});

self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'MHS Today', {
    body: msg.body || '', icon: '/app-icon-192.png', badge: '/icon-32.png', data: { url: msg.url || '/' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if (w.url === target && 'focus' in w) return w.focus();
    return self.clients.openWindow(target);
  })());
});
