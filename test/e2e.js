// Browser end-to-end check (manual; not part of `npm test`). Drives the real pages in Chromium against the
// real server and a mock Google, with the server's clock pinned to a school morning so the live countdown is
// predictable. Needs Playwright:   npm i --no-save playwright && npx playwright install chromium
//   node test/e2e.js            (set CHROMIUM_PATH to use an existing Chromium; screenshots go to $TMPDIR/mhs-e2e)
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = path.join(__dirname, '..');
const SHOTS = path.join(os.tmpdir(), 'mhs-e2e');
fs.mkdirSync(SHOTS, { recursive: true });
const { startApp } = require('./helpers');
const { startMockGoogle } = require('./mock-google');

// Server clock pinned to Thursday 2026-10-01, 10:00 AM in Chicago (15:00 UTC), ticking normally.
const FAKE = Date.parse('2026-10-01T15:00:00Z');
const realNow = Date.now; const t0 = realNow();
Date.now = () => FAKE + (realNow() - t0);

const problems = [];
const step = (m) => console.log('•', m);

(async () => {
  const mock = await startMockGoogle();
  const ctx = await startApp({ mock, env: { ALLOWED_DOMAINS: 'school.test', ADMIN_EMAILS: 'admin@school.test' } });
  const base = ctx.local;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

  async function newUser(name, identity, opts = {}) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, ...opts });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e.message}`));
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${name}] console.${m.type()}: ${m.text()}`); });
    page.on('dialog', (d) => d.accept());
    return { name, context, page, identity };
  }
  async function signIn(u, next) {
    mock.identity = { email_verified: true, hd: 'school.test', ...u.identity };
    await u.page.goto(base + '/login.html' + (next ? `?next=${encodeURIComponent(next)}` : ''));
    await u.page.click('#google-btn');
    await u.page.waitForURL((url) => !/login\.html|\/auth\//.test(url.pathname), { timeout: 10000 });
  }
  const text = (p, sel) => p.locator(sel).innerText();

  // ---------------------------------------------------------------- anonymous visitor
  const anon = await newUser('anon', {});
  await anon.page.goto(base + '/');
  await anon.page.waitForSelector('#day-head h1');
  step('anonymous dashboard: ' + (await text(anon.page, '#day-head')).replace(/\n+/g, ' | '));
  assert.match(await text(anon.page, '#day-head'), /Thursday, October 1/);
  assert.match(await text(anon.page, '#day-head'), /Day \?|day letter/i);
  assert.match(await text(anon.page, '#friends-preview'), /Sign in/);
  await anon.page.goto(base + '/events.html');
  await anon.page.waitForSelector('#upcoming');
  assert.equal(await anon.page.locator('#add-card').isHidden(), true);
  assert.equal(await anon.page.locator('#signin-card').isVisible(), true);
  await anon.page.goto(base + '/schedule.html');             // protected page sends you to sign in and remembers where you were going
  await anon.page.waitForURL(/login\.html\?next=schedule\.html/);
  step('protected page redirects to sign-in with next=');
  await anon.page.goto(base + '/login.html?error=domain');
  await anon.page.waitForSelector('#login-error:not([hidden])');
  assert.match(await text(anon.page, '#login-error'), /@school\.test/);
  assert.match(await text(anon.page, '#login-hint'), /school Google account \(@school\.test\)/);
  await anon.page.screenshot({ path: path.join(SHOTS, 'login-error.png') });

  // a Google account from another domain is turned away with a clear message
  await anon.page.goto(base + '/login.html');
  mock.identity = { sub: 'x', email: 'x@gmail.com', email_verified: true, given_name: 'Out', family_name: 'Sider' };
  await anon.page.click('#google-btn');
  await anon.page.waitForURL(/login\.html\?error=domain/);
  await anon.page.waitForSelector('#login-error:not([hidden])');
  step('outside domain rejected: ' + await text(anon.page, '#login-error'));

  // ---------------------------------------------------------------- admin sets up the calendar
  const admin = await newUser('admin', { sub: 'a1', email: 'admin@school.test', given_name: 'Ada', family_name: 'Min' });
  await signIn(admin);
  const ap = admin.page;
  await ap.waitForSelector('.nav-auth a[href="admin.html"]');
  step('admin signed in, nav shows Admin link');
  await ap.goto(base + '/admin.html');
  await ap.waitForSelector('#admin-body:not([hidden])');
  assert.match(await text(ap, '#setup'), /Google sign-in is configured/);
  assert.match(await text(ap, '#setup'), /Only these Google Workspace domains/);
  assert.match(await text(ap, '#setup'), /day letter has not been set/i);
  await ap.fill('#anchor-date', '2026-09-28');
  await ap.selectOption('#anchor-letter', 'B');
  await ap.click('#anchor-form button');
  await ap.waitForFunction(() => /Day letter rotation is set/.test(document.querySelector('#setup').innerText));
  assert.match(await text(ap, '#preview'), /Thu, Oct 1\s+Day A/);   // Mon 9/28=B, Tue=C, Wed=D, Thu=A
  step('day letter rotation: Oct 1 is Day A');
  await ap.selectOption('select[aria-label="Wednesday schedule"]', 'advisory');
  await ap.waitForFunction(() => /Advisory/.test(document.querySelector('#preview').innerText));
  await ap.fill('#ns-from', '2026-10-05'); await ap.fill('#ns-to', '2026-10-07'); await ap.fill('#ns-label', 'Fall break');
  await ap.click('#noschool-form button');
  await ap.waitForFunction(() => /Fall break/.test(document.querySelector('#noschool-list').innerText));
  assert.doesNotMatch(await text(ap, '#preview'), /Oct 5|Oct 6|Oct 7/);
  assert.match(await text(ap, '#preview'), /Oct 8\s+Day C/); // Fri 10/2=B, then 10/5-7 skipped, Thu 10/8 = C
  await ap.fill('#ty-date', '2026-10-09'); await ap.selectOption('#ty-type', 'early_release');
  await ap.click('#type-form button');
  await ap.waitForFunction(() => /Early release/.test(document.querySelector('#type-list').innerText));
  step('calendar: weekday pattern, break and special day saved; preview updates');
  await ap.screenshot({ path: path.join(SHOTS, 'admin.png'), fullPage: true });

  // ---------------------------------------------------------------- two students
  const ann = await newUser('ann', { sub: 's1', email: 'ann@school.test', given_name: 'Ann', family_name: 'Lee' });
  const ben = await newUser('ben', { sub: 's2', email: 'ben@school.test', given_name: 'Ben', family_name: 'Ray' }, { viewport: { width: 390, height: 844 }, isMobile: true });
  await signIn(ann, 'schedule.html');
  assert.match(ann.page.url(), /schedule\.html$/);
  step('sign-in returned to the page the student wanted');
  const sp = ann.page;
  await sp.waitForSelector('#panel-A .slot');
  assert.equal(await sp.locator('#tab-A').getAttribute('aria-selected'), 'true'); // today is Day A
  const fillSlot = async (day, hour, name, teacher, room) => {
    await sp.fill(`[data-day="${day}"][data-hour="${hour}"][data-field="name"]`, name);
    await sp.fill(`[data-day="${day}"][data-hour="${hour}"][data-field="teacher"]`, teacher);
    await sp.fill(`[data-day="${day}"][data-hour="${hour}"][data-field="room"]`, room);
  };
  await fillSlot('A', 1, 'English 10', 'Ms. Quill', '110');
  await fillSlot('A', 2, 'Algebra II', 'Mr. Sum', '204');
  await fillSlot('A', 3, 'Chemistry', 'Dr. Mole', '305');
  await fillSlot('A', 4, 'Spanish 2', 'Sra. Sol', '118');
  await sp.fill('[data-day="A"][data-hour="5"][data-field="name"]', '<img src=x onerror="window.__xss=1">');
  assert.match(await text(sp, '#save-state'), /Unsaved/);
  await sp.click('#day-actions button:has-text("Copy Day A")');
  assert.equal(await sp.inputValue('[data-day="C"][data-hour="3"][data-field="name"]'), 'Chemistry');
  await sp.click('#tab-B'); await sp.click('#day-actions button:has-text("Clear Day B")');
  assert.equal(await sp.inputValue('[data-day="B"][data-hour="3"][data-field="name"]'), '');
  await sp.click('#save-btn');
  await sp.waitForFunction(() => document.querySelector('#save-state').innerText === '');
  await sp.reload(); await sp.waitForSelector('#panel-A .slot');
  assert.equal(await sp.inputValue('[data-day="A"][data-hour="3"][data-field="name"]'), 'Chemistry');
  assert.equal(await sp.inputValue('[data-day="D"][data-hour="2"][data-field="teacher"]'), 'Mr. Sum');
  assert.equal(await sp.evaluate(() => window.__xss), undefined, 'class names never execute as HTML');
  await sp.screenshot({ path: path.join(SHOTS, 'schedule.png'), fullPage: true });
  step('schedule: edit, copy day, clear day, save, reload persisted; HTML in a class name stays text');

  // dashboard with live status (Thu 10:00 AM = Hour 3)
  await sp.goto(base + '/index.html');
  await sp.waitForSelector('#schedule-body tr.period-row.current');
  const status = await text(sp, '#status');
  step('dashboard now-card: ' + status.replace(/\n+/g, ' | '));
  assert.match(status, /Hour 3 · \d+ min left/);
  assert.match(status, /Chemistry \(Rm 305\)/);
  assert.match(status, /Next: Hour 4 \(\+ Lunch\) – Spanish 2 \(Rm 118\) at 10:56 AM/);
  assert.match(await text(sp, '#day-head'), /Thursday, October 1[\s\S]*Day A/);
  assert.match(await text(sp, '#schedule-body tr.current'), /Hour 3[\s\S]*9:49 AM – 10:51 AM[\s\S]*Chemistry/);
  assert.match(await text(sp, '#schedule-body'), /9:44 AM – 9:49 AM · MTV & Announcements/);
  await sp.screenshot({ path: path.join(SHOTS, 'dashboard-ann.png'), fullPage: true });
  // next school day: Fri 10/2 (Day B) then skips the break to Thu 10/8 (Day C)
  await sp.click('button:has-text("Next school day")');
  assert.match(await text(sp, '#day-head'), /Friday, October 2[\s\S]*Day B/);
  await sp.click('button:has-text("Next school day")');
  assert.match(await text(sp, '#day-head'), /Thursday, October 8[\s\S]*Day C/);
  await sp.click('button:has-text("Next school day")');
  assert.match(await text(sp, '#day-head'), /Friday, October 9[\s\S]*Early release/);
  assert.equal(await sp.locator('#status').isHidden(), true);
  await sp.click('button:has-text("Back to today")');
  assert.match(await text(sp, '#day-head'), /Thursday, October 1/);
  step('day navigation skips the break; special schedule shown; back to today works');

  // ---------------------------------------------------------------- friends (Ben on a phone-sized screen)
  await sp.goto(base + '/friends.html'); await sp.waitForSelector('#my-code:not(:text("…"))');
  const annCode = (await text(sp, '#my-code')).replace('-', '');
  assert.match(annCode, /^[A-HJKMNP-Z2-9]{10}$/);
  await signIn(ben, `friends.html?code=${annCode}`);       // invite link flow: sign in, come back, confirm, send
  const bp = ben.page;
  await bp.waitForSelector('#confirm-box:not([hidden])');
  assert.match(await text(bp, '#confirm-box'), /Send a friend request to\s*Ann L\./);
  assert.doesNotMatch(bp.url(), /code=/, 'the code is removed from the address bar');
  await bp.click('#confirm-box button:has-text("Send request")');
  await bp.waitForFunction(() => /Request sent to/.test(document.querySelector('#requests').innerText));
  step('invite link: sign in -> confirm -> request sent');
  await sp.reload(); await sp.waitForSelector('#requests button:has-text("Accept")');
  assert.match(await text(sp, '#requests'), /Ben R\. wants to be friends/);
  await sp.click('#requests button:has-text("Accept")');
  await sp.waitForFunction(() => /Ben R\./.test(document.querySelector('#friends').innerText));
  await sp.screenshot({ path: path.join(SHOTS, 'friends.png'), fullPage: true });
  // a wrong code gives a clear message, a malformed one too
  await sp.fill('#friend-code', 'AAAAA-AAAAA'); await sp.click('#find-form button');
  await sp.waitForSelector('#confirm-box.error');
  assert.match(await text(sp, '#confirm-box'), /No one has that code/);
  // Ben fills in a schedule that overlaps with Ann's Algebra and Chemistry
  await bp.goto(base + '/schedule.html'); await bp.waitForSelector('#panel-A .slot');
  await bp.fill('[data-day="A"][data-hour="2"][data-field="name"]', 'algebra ii');
  await bp.fill('[data-day="A"][data-hour="2"][data-field="teacher"]', 'Mr. Sum');
  await bp.fill('[data-day="A"][data-hour="3"][data-field="name"]', 'Physics');
  await bp.fill('[data-day="A"][data-hour="3"][data-field="room"]', '301');
  await bp.click('#save-btn'); await bp.waitForFunction(() => document.querySelector('#save-state').innerText === '');
  await bp.goto(base + '/index.html'); await bp.waitForSelector('#schedule-body tr.current');
  assert.match(await text(bp, '#friends-preview'), /Ann L\.[\s\S]*Chemistry · Rm 305/);
  assert.match(await text(bp, '#schedule-body'), /Algebra/i);
  assert.match(await text(bp, '#schedule-body tr[data-hour="2"]'), /With Ann L\./);
  assert.doesNotMatch(await text(bp, '#schedule-body tr[data-hour="3"]'), /With/);
  await bp.screenshot({ path: path.join(SHOTS, 'dashboard-ben-mobile.png'), fullPage: true });
  step('friends: accepted; friend shown in current class; shared-class hint on matching hours only');

  // ---------------------------------------------------------------- events + XSS
  const ep = ann.page;
  await ep.goto(base + '/events.html'); await ep.waitForSelector('#add-card:not([hidden])');
  await ep.fill('#title', '<img src=x onerror="window.__xss2=1"> Pep rally');
  await ep.fill('#date', '2026-10-03'); await ep.fill('#time', '14:30'); await ep.fill('#description', '<script>window.__xss3=1</script>Gym');
  await ep.click('#event-form button');
  await ep.waitForSelector('#upcoming .list-row');
  assert.match(await text(ep, '#upcoming'), /Pep rally/);
  assert.match(await text(ep, '#upcoming'), /2:30 PM/);
  assert.match(await text(ep, '#upcoming'), /added by Ann L\./);
  await ep.screenshot({ path: path.join(SHOTS, 'events.png'), fullPage: true });
  assert.equal(await ep.evaluate(() => [window.__xss2, window.__xss3]).then((a) => a.join()), ',');
  assert.equal(await ep.locator('#upcoming img, #upcoming script').count(), 0);
  await bp.goto(base + '/events.html'); await bp.waitForSelector('#upcoming .list-row');
  assert.equal(await bp.locator('#upcoming button:has-text("Delete")').count(), 0, "students can't delete each other's events");
  assert.equal(await ep.locator('#upcoming button:has-text("Delete")').count(), 1);
  await ap.goto(base + '/events.html'); await ap.waitForSelector('#upcoming .list-row');
  assert.equal(await ap.locator('#upcoming button:has-text("Delete")').count(), 1, 'admins can delete any event');
  await ep.click('#upcoming button:has-text("Delete")');
  await ep.waitForFunction(() => /No upcoming events/.test(document.querySelector('#upcoming').innerText));
  step('events: HTML in titles/details stays text; delete rights are right');

  // ---------------------------------------------------------------- account: privacy, rename, delete
  await sp.goto(base + '/account.html'); await sp.waitForSelector('#name');
  await sp.fill('#name', 'Annie'); await sp.click('#name-form button');
  await sp.waitForFunction(() => document.querySelector('.nav-auth').innerText.includes('Annie'));
  await sp.uncheck('#share');
  await sp.waitForSelector('.toast:has-text("hidden from friends")');
  await bp.goto(base + '/friends.html');
  await bp.waitForFunction(() => /Schedule hidden/.test(document.querySelector('#friends').innerText));
  assert.match(await text(bp, '#friends'), /Annie/);
  step('account: rename shows in the nav; privacy switch hides the schedule from friends');
  await sp.screenshot({ path: path.join(SHOTS, 'account.png'), fullPage: true });

  // ---------------------------------------------------------------- backup + restore through the UI
  await ap.goto(base + '/admin.html'); await ap.waitForSelector('#users tr');
  assert.equal(await ap.locator('#users tr').count(), 3);
  const [download] = await Promise.all([ap.waitForEvent('download'), ap.click('#backup-link')]);
  const backupPath = path.join(SHOTS, 'backup.json');
  await download.saveAs(backupPath);
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(backup.users.length, 3);
  // a student leaves; the admin then restores the backup and gets them back
  const carl = await newUser('carl', { sub: 's3', email: 'carl@school.test', given_name: 'Carl', family_name: 'Fox' });
  await signIn(carl);
  await carl.page.goto(base + '/account.html'); await carl.page.waitForSelector('#name');
  await carl.page.fill('#confirm-delete', 'delete'); await carl.page.click('#delete-btn');
  await carl.page.waitForURL(/index\.html$/);
  assert.equal(Object.keys(ctx.app.state.users).length, 3);
  await ap.reload(); await ap.waitForSelector('#users tr');
  await ap.setInputFiles('#restore-file', backupPath);
  assert.equal(await ap.locator('#restore-btn').isDisabled(), true);
  await ap.fill('#restore-confirm', 'RESTORE');
  await ap.click('#restore-btn');
  await ap.waitForSelector('.toast:has-text("Restored 3 people and 0 events")');
  await ap.waitForLoadState('load'); await ap.waitForSelector('#users tr');   // the page reloads itself after a restore
  assert.equal(await ap.locator('#users tr').count(), 3);
  assert.equal(Object.keys(ctx.app.state.users).length, 3);
  step('backup downloaded; account deleted; restore through the UI brought everyone back');

  // ---------------------------------------------------------------- phones: no sideways scrolling anywhere
  const phone = await newUser('phone', { sub: 'a1', email: 'admin@school.test', given_name: 'Ada', family_name: 'Min' }, { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  await signIn(phone);
  for (const pg of ['index', 'schedule', 'events', 'friends', 'tools', 'account', 'admin', 'login']) {
    await phone.page.goto(`${base}/${pg}.html`);
    await phone.page.waitForLoadState('networkidle');
    await phone.page.waitForTimeout(250);
    const w = await phone.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
    if (w.scroll > w.view) {
      const culprit = await phone.page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 4).map((e) => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)));
      problems.push(`[phone] ${pg}.html scrolls sideways (${w.scroll} > ${w.view}): ${culprit.join(', ')}`);
    }
    if (['index', 'schedule', 'friends', 'admin'].includes(pg)) await phone.page.screenshot({ path: path.join(SHOTS, `phone-${pg}.png`), fullPage: true });
  }
  step('phone layout checked on every page');

  // ---------------------------------------------------------------- look & feel: dark mode + keyboard
  const dark = await newUser('dark', { sub: 's1', email: 'ann@school.test', given_name: 'Ann', family_name: 'Lee' }, { colorScheme: 'dark' });
  await signIn(dark);
  await dark.page.goto(base + '/index.html'); await dark.page.waitForSelector('#schedule-body tr.current');
  await dark.page.screenshot({ path: path.join(SHOTS, 'dashboard-dark.png'), fullPage: true });
  await sp.goto(base + '/index.html'); await sp.waitForSelector('#day-head h1');
  await sp.keyboard.press('Tab');
  assert.equal(await sp.evaluate(() => document.activeElement.className), 'skip-link');

  await browser.close(); await ctx.close(); await mock.close();
  const real = problems.filter((p) => !/Failed to load resource: the server responded with a status of (401|403|404|429)/.test(p));
  console.log(`Screenshots: ${SHOTS}`);
  console.log(real.length ? '\nPROBLEMS:\n' + real.join('\n') : '\nNo console errors, page errors or CSP violations.');
  if (real.length) process.exitCode = 1;
})().catch((e) => { console.error('\nE2E FAILED:', e.message.split('\n').slice(0, 12).join('\n')); process.exit(1); });
