'use strict';
// Visitor counts for admins: people (not bots), once a day each, signed-in people counted once too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isHuman } = require('../src/visits');
const { startApp, closeAll, user } = require('./helpers');
const { startMockGoogle } = require('./mock-google');

let mock;
test.before(async () => { mock = await startMockGoogle(); });
test.after(async () => { await mock.close(); });
test.afterEach(closeAll);

const CHROME = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const browser = (ua = CHROME, more = {}) => ({ 'user-agent': ua, 'accept-language': 'en-US', ...more });

test('bots, link previews, scripts and prefetches are not people', () => {
  const req = (headers, method = 'GET') => ({ method, headers });
  assert.equal(isHuman(req(browser())), true);
  for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'Mozilla/5.0 (Linux) HeadlessChrome/120',
    'Slackbot-LinkExpanding 1.0', 'curl/8.4', 'python-requests/2.31', 'Mozilla/5.0 (compatible; UptimeRobot/2.0)', 'facebookexternalhit/1.1', '']) {
    assert.equal(isHuman(req(browser(ua))), false, ua);
  }
  assert.equal(isHuman(req({ 'user-agent': CHROME })), false, 'no language: a script');
  assert.equal(isHuman(req(browser(CHROME, { 'sec-purpose': 'prefetch;prerender' }))), false);
  assert.equal(isHuman(req(browser(), 'HEAD')), false);
});

test('visitors: once a day each, signed in counted too, only pages, and admins only', async () => {
  const ctx = await startApp({ mock });
  const boss = ctx.client();
  await boss.signIn(mock, user(99, { email: 'admin@school.test', given_name: 'Ada' }));
  const kid = ctx.client();
  await kid.signIn(mock, user(1, { given_name: 'Kim' }));
  const anon = ctx.client();
  const open = (c, p, ua) => c.raw('GET', p, { headers: browser(ua), xhr: false });
  await open(anon, '/index.html'); await open(anon, '/events.html'); await open(anon, '/');
  await open(anon, '/index.html', 'Mozilla/5.0 (Macintosh) Safari/605'); // a second browser on the same network
  await open(kid, '/index.html'); await open(kid, '/friends.html');
  await open(anon, '/css/style.css'); await open(anon, '/api/health'); await open(anon, '/nope.html'); // not pages
  await anon.raw('GET', '/index.html', { headers: { 'user-agent': 'Googlebot/2.1' }, xhr: false });
  assert.equal((await kid.get('/api/admin/visits')).status, 403);
  const { days } = (await boss.get('/api/admin/visits')).data;
  assert.equal(days.length, 30);
  assert.deepEqual(days[29], { date: days[29].date, visitors: 2, signedIn: 1, views: 6 }, 'kid and anon share a network and browser: one visitor');
  assert.deepEqual(days[0], { date: days[0].date, visitors: 0, signedIn: 0, views: 0 });
  await ctx.app.close(); // counts are saved on shutdown and contain no addresses or ids
  const saved = fs.readFileSync(path.join(ctx.dataDir, 'visits.json'), 'utf8');
  assert.ok(!saved.includes('127.0.0.1') && !saved.includes('Kim') && !saved.includes(CHROME), 'nothing that identifies anyone');
  assert.equal(JSON.parse(saved).days[days[29].date].visitors, 2);
});
