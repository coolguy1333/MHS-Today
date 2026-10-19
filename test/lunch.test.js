'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../public/js/calendar.js');
const { createMenu, parseMonth } = require('../src/menu');
const { startApp, closeAll } = require('./helpers');
const { startMockGoogle } = require('./mock-google');

let mock;
test.before(async () => { mock = await startMockGoogle(); });
test.after(async () => { await mock.close(); });
test.afterEach(closeAll);

const today = () => cal.schoolNow('America/Chicago').date;
const item = (type, name, extra = {}) => ({ item: name, weight: 0, name, type, ...extra });
// The shape Health-e Pro sends: one entry per day, the menu itself a JSON string in `setting`.
function entry(day, display) {
  return { id: 1, day: `${day}T00:00:00.000000Z`, meal_id: 2, setting: JSON.stringify({ current_display: display, days_off: [] }) };
}
const SAMPLE = [
  item('category', "Muk Way Cafe' ($4.00)"), item('recipe', 'WG Chicken Nuggets'), item('text', 'Or'), item('recipe', 'BBQ Meatballs'),
  item('category', 'Pizza, Pizza ($3.85)'), item('recipe', 'Cheese Pizza'),
  item('category', 'Empty counter')
];

// A fake menu service: answers for the months in `data`, counts calls, can be made to fail.
function fakeService(data) {
  const svc = { calls: [], fail: false };
  svc.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://menus.healthepro.com/')) return fetch(url, opts); // mock Google etc.
    svc.calls.push(String(url));
    if (svc.fail) throw new Error('network down');
    const m = /\/year\/(\d{4})\/month\/(\d{2})\//.exec(url);
    const body = data[`${m[1]}-${m[2]}`];
    if (!body) return new Response('Not found', { status: 404 });
    return new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return svc;
}

test('menu: a month of entries becomes counters and dishes; empty days and junk are skipped', () => {
  const days = parseMonth({
    data: [
      entry('2026-10-15', SAMPLE),
      entry('2026-10-16', [item('category', 'No food here')]),
      null, 'junk', { day: 'not a date', setting: '{}' }, { day: '2026-10-17', setting: 'not json' },
      entry('2026-10-19', [item('recipe', 'Soup'), item('recipe', '  Bread‮  ')])
    ]
  });
  assert.deepEqual(Object.keys(days), ['2026-10-15', '2026-10-19']);
  assert.deepEqual(days['2026-10-15'].sections, [
    { title: "Muk Way Cafe' ($4.00)", items: [{ name: 'WG Chicken Nuggets', kind: 'food' }, { name: 'Or', kind: 'note' }, { name: 'BBQ Meatballs', kind: 'food' }] },
    { title: 'Pizza, Pizza ($3.85)', items: [{ name: 'Cheese Pizza', kind: 'food' }] }
  ]);
  assert.deepEqual(days['2026-10-19'].sections, [{ title: '', items: [{ name: 'Soup', kind: 'food' }, { name: 'Bread', kind: 'food' }] }]);
  assert.deepEqual(parseMonth({ data: 'nope' }), {});
  assert.deepEqual(parseMonth(null), {});
});

test('menu: months are cached, refreshed after an hour, and the last good copy survives an outage', async () => {
  let clock = 1e12;
  const svc = fakeService({ '2026-10': [entry('2026-10-15', SAMPLE)] });
  const logs = [];
  const menu = createMenu({ district: '2534', menuId: '133305', fetchFn: svc.fetch, now: () => clock, log: (m) => logs.push(m) });
  assert.equal(menu.pageUrl, 'https://www.myschoolmenus.com/organizations/2534/menus/133305', 'no site number: the My School Menus page');
  assert.equal(createMenu({ district: '2534', menuId: '133305', site: '15466' }).pageUrl, 'https://menus.healthepro.com/organizations/2534/sites/15466/menus/133305');

  const d = await menu.day('2026-10-15');
  assert.equal(d.available, true); assert.equal(d.sections.length, 2);
  assert.match(svc.calls[0], /^https:\/\/menus\.healthepro\.com\/api\/organizations\/2534\/menus\/133305\/year\/2026\/month\/10\/date_overwrites$/);
  assert.deepEqual(await menu.day('2026-10-16'), { date: '2026-10-16', available: false, sections: [] });
  assert.equal(svc.calls.length, 1, 'same month, no second request');

  clock += 61 * 60e3;
  svc.fail = true;
  await menu.day('2026-10-15'); // starts a background refresh, answers from the cache
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await menu.day('2026-10-15')).available, true, 'stale copy used while the service is down');
  assert.equal(svc.calls.length, 2, 'no retry storm');
  assert.ok(logs.some((l) => /could not be loaded: network down/.test(l)));

  assert.deepEqual(await menu.day('2026-11-02'), { date: '2026-11-02', available: false, sections: [], error: 'unavailable' });
  svc.fail = false;
  assert.deepEqual(await menu.day('2026-11-03'), { date: '2026-11-03', available: false, sections: [], error: 'unavailable' }, 'waits before retrying');
  clock += 6 * 60e3;
  assert.deepEqual(await menu.day('2026-11-03'), { date: '2026-11-03', available: false, sections: [] }, 'a month with no menu is a 404, not an error');

  const off = createMenu({ district: '2534', menuId: '', fetchFn: svc.fetch });
  assert.equal(off.enabled, false);
  assert.equal((await off.day('2026-10-15')).error, 'not-configured');
});

test('lunch API: anyone can read it, dates are limited, the source link is included', async () => {
  const t = today();
  const svc = fakeService({ [t.slice(0, 7)]: [entry(t, SAMPLE)] });
  const ctx = await startApp({ mock, fetchFn: svc.fetch });
  const anon = ctx.client();
  const r = await anon.get('/api/lunch');
  assert.equal(r.status, 200);
  assert.equal(r.data.date, t); assert.equal(r.data.available, true);
  assert.equal(r.data.sections[0].title, "Muk Way Cafe' ($4.00)");
  assert.equal(r.data.source, 'https://menus.healthepro.com/organizations/2534/sites/15466/menus/133305');
  assert.equal((await anon.get(`/api/lunch?date=${t}`)).data.available, true);
  for (const bad of ['2026-02-31', 'tomorrow', cal.addDays(t, 61), cal.addDays(t, -61)]) {
    assert.equal((await anon.get(`/api/lunch?date=${bad}`)).status, 400, bad);
  }

  const off = await startApp({ mock, fetchFn: svc.fetch, env: { MENU_ID: 'off' } });
  const o = (await off.client().get('/api/lunch')).data;
  assert.equal(o.error, 'not-configured'); assert.equal(o.source, null);

  const other = await startApp({ mock, fetchFn: svc.fetch, env: { MENU_DISTRICT: '99', MENU_ID: '42' } });
  await other.client().get('/api/lunch');
  assert.match(svc.calls.at(-1), /organizations\/99\/menus\/42\//);
});
