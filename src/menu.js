'use strict';
// School lunch menu from Health-e Pro ("My School Menus"), the public menu service the district uses.
// A month is fetched once and kept for an hour; if the service is down, the last good copy is used.
const { cleanText } = require('./util');

const BASE = 'https://menus.healthepro.com/api';
const FRESH_MS = 60 * 60e3;   // re-fetch a month after an hour
const RETRY_MS = 5 * 60e3;    // after a failure, wait this long before trying again
const MAX_BYTES = 2 * 1024 * 1024;

// One day's raw entry -> { sections: [{ title, items: [{ name, kind }] }] } or null when nothing is served.
function parseDay(entry) {
  let setting;
  try { setting = JSON.parse(entry.setting); } catch { return null; }
  const display = setting && Array.isArray(setting.current_display) ? setting.current_display : [];
  const sections = [];
  let current = null;
  let recipes = 0;
  for (const it of display.slice(0, 200)) {
    if (!it || typeof it !== 'object') continue;
    const name = cleanText(it.name, 120);
    if (!name) continue;
    if (it.type === 'category') {
      current = { title: name, items: [] };
      sections.push(current);
    } else if (it.type === 'recipe' || it.type === 'text') {
      if (!current) { current = { title: '', items: [] }; sections.push(current); }
      current.items.push({ name, kind: it.type === 'recipe' ? 'food' : 'note' });
      if (it.type === 'recipe') recipes++;
    }
  }
  return recipes ? { sections: sections.filter((s) => s.items.length) } : null;
}

// `{ 'YYYY-MM-DD': { sections } }` for one month's API response.
function parseMonth(body) {
  const out = {};
  const list = body && Array.isArray(body.data) ? body.data : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || typeof entry.day !== 'string') continue;
    const date = entry.day.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const day = parseDay(entry);
    if (day) out[date] = day;
  }
  return out;
}

function createMenu({ district, menuId, fetchFn = fetch, log = () => {}, now = Date.now }) {
  const months = new Map(); // 'YYYY-MM' -> { days, fetched, failedAt, pending }
  const enabled = !!(district && menuId);
  const pageUrl = enabled ? `https://www.myschoolmenus.com/organizations/${district}/menus/${menuId}` : null;

  async function fetchMonth(ym) {
    const [y, m] = ym.split('-');
    const url = `${BASE}/organizations/${district}/menus/${menuId}/year/${y}/month/${m}/date_overwrites`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { accept: 'application/json' } });
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`menu service answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('menu response too large');
    return parseMonth(JSON.parse(text));
  }

  async function month(ym) {
    let m = months.get(ym);
    if (!m) { m = { days: null, fetched: 0, failedAt: 0, pending: null }; months.set(ym, m); }
    const t = now();
    const stale = !m.days || t - m.fetched > FRESH_MS;
    if (stale && !m.pending && t - m.failedAt > RETRY_MS) {
      m.pending = fetchMonth(ym)
        .then((days) => { m.days = days; m.fetched = now(); })
        .catch((e) => { m.failedAt = now(); log(`Lunch menu for ${ym} could not be loaded: ${e.message}`); })
        .finally(() => { m.pending = null; });
    }
    if (m.pending && !m.days) await m.pending; // first load waits; later refreshes happen in the background
    if (months.size > 24) months.delete(months.keys().next().value);
    return m.days;
  }

  // -> { date, available, sections, error? }
  async function day(date) {
    if (!enabled) return { date, available: false, sections: [], error: 'not-configured' };
    const days = await month(date.slice(0, 7));
    if (!days) return { date, available: false, sections: [], error: 'unavailable' };
    const d = days[date];
    return { date, available: !!d, sections: d ? d.sections : [] };
  }

  return { day, enabled, pageUrl };
}

module.exports = { createMenu, parseMonth };
