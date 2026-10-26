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
  // EVENT_POSTING=verified is the real default (the test helper opens posting to everyone)
  const ctx = await startApp({ mock, env: { ALLOWED_DOMAINS: 'school.test', ADMIN_EMAILS: 'admin@school.test', EVENT_POSTING: 'verified' } });
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
  async function signIn(u, next, role = 'student') {
    mock.identity = { email_verified: true, hd: 'school.test', ...u.identity };
    await u.page.goto(base + '/login.html' + (next ? `?next=${encodeURIComponent(next)}` : ''));
    await u.page.click('#google-btn');
    await u.page.waitForURL((url) => !/login\.html|\/auth\//.test(url.pathname), { timeout: 10000 });
    // first sign-in: read and agree to the Privacy & Terms, then on to where they were going
    await u.page.waitForLoadState('networkidle');
    if (/terms\.html/.test(u.page.url())) {
      if (await u.page.locator('#role-pick').isVisible()) await u.page.click(`#role-pick .choice:has(input[value="${role}"])`); // a new account: student or teacher
      await u.page.check('#agree-box');
      await u.page.click('#agree-btn');
      await u.page.waitForURL((url) => !/terms\.html/.test(url.pathname), { timeout: 10000 });
    }
  }
  const text = (p, sel) => p.locator(sel).innerText();

  // ---------------------------------------------------------------- anonymous visitor
  const anon = await newUser('anon', {});
  await anon.page.goto(base + '/');
  await anon.page.waitForSelector('#day-head h1');
  // the installable app: the manifest must load under the site's CSP (Chromium only fetches it on request)
  const manifest = await (await anon.page.context().newCDPSession(anon.page)).send('Page.getAppManifest');
  assert.ok(manifest.data && !(manifest.errors || []).length, 'web app manifest loads');
  step('anonymous dashboard: ' + (await text(anon.page, '#day-head')).replace(/\n+/g, ' | '));
  assert.match(await text(anon.page, '#day-head'), /Thursday, October 1/);
  assert.match(await text(anon.page, '#day-head'), /Day \?|day letter/i);
  assert.match(await text(anon.page, '#friends-preview'), /Sign in/);
  // signed out, Today is the only page: the nav has just Today and Sign in, the rest ask you to sign in
  await anon.page.waitForSelector('.nav-auth a[href="login.html"]');
  assert.deepEqual(await anon.page.locator('.nav-wide a').allInnerTexts(), ['Today']);
  for (const pg of ['events', 'lunch', 'links', 'groups', 'calendar']) {
    await anon.page.goto(`${base}/${pg}.html`);
    await anon.page.waitForURL(new RegExp(`login\\.html\\?next=${pg}\\.html`));
  }
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
  // the Overview shows only what needs fixing; everything else is under "Site settings"
  assert.match(await text(ap, '#problems'), /day letter has not been set/i);
  assert.doesNotMatch(await text(ap, '#problems'), /Google sign-in is configured|Workspace domains/);
  assert.match(await ap.locator('#setup').textContent(), /Google sign-in is configured[\s\S]*Only these Google Workspace domains/);
  const dayCell = (label) => ap.locator(`#month .mday[aria-label^="${label}:"]`);
  await ap.click('#tabs [data-tab="calendar"]');
  assert.match(ap.url(), /#calendar$/);
  await ap.fill('#anchor-date', '2026-09-28');
  await ap.selectOption('#anchor-letter', 'B');
  await ap.click('#anchor-form button');
  await ap.waitForFunction(() => !/day letter has not been set/i.test(document.querySelector('#problems').textContent));
  assert.match(await dayCell('Thursday, October 1').getAttribute('aria-label'), /Day A, Regular/); // Mon 9/28=B, Tue=C, Wed=D, Thu=A
  step('day letter rotation: Oct 1 is Day A (month calendar)');
  await ap.selectOption('select[aria-label="Wednesday schedule"]', 'advisory');
  await ap.waitForFunction(() => /Advisory/.test(document.querySelector('#month .mday[aria-label^="Wednesday, September 30:"]').getAttribute('aria-label')));
  await ap.fill('#ns-from', '2026-10-05'); await ap.fill('#ns-to', '2026-10-07'); await ap.fill('#ns-label', 'Fall break');
  await ap.click('#noschool-form button');
  await ap.waitForFunction(() => /Fall break/.test(document.querySelector('#noschool-list').innerText));
  assert.match(await dayCell('Monday, October 5').getAttribute('aria-label'), /Fall break/);
  assert.match(await dayCell('Thursday, October 8').getAttribute('aria-label'), /Day C/); // Fri 10/2=B, then 10/5-7 skipped, Thu 10/8 = C
  // one special day: click it in the month, pick Early release
  await dayCell('Friday, October 9').click();
  await ap.click('#day-panel button:has-text("Early release")');
  await ap.waitForFunction(() => /Early release/.test(document.querySelector('#type-list').innerText));
  assert.match(await dayCell('Friday, October 9').getAttribute('aria-label'), /Early release/);
  // a custom schedule pasted from Infinite Campus, used on a day; then a day off from the day panel
  await ap.click('#custom-new');
  await ap.fill('#custom-editor textarea', 'Day: MukReady\nPeriod Pre-Adv\nAdvisory (Juniors)\n7:30 AM - 8:05 AM\nPeriod Speaker1\nTrack #1\n8:10 AM - 8:40 AM\nPeriod Green\nEnglish\n10:56 AM - 12:31 PM\nPeriod Purple\nPhysics\n12:36 PM - 1:38 PM');
  await ap.click('#custom-editor button:has-text("Read it")');
  assert.equal(await ap.locator('#custom-editor .period-edit:not(.head)').count(), 4);
  await ap.click('#custom-editor button[type=submit]');
  await ap.waitForFunction(() => /MukReady/.test(document.querySelector('#custom-list').innerText));
  await dayCell('Monday, October 12').click();
  await ap.click('#day-panel button:has-text("MukReady")');
  await ap.waitForFunction(() => /MukReady/.test(document.querySelector('#month .mday[aria-label^="Monday, October 12:"]').getAttribute('aria-label')));
  await dayCell('Tuesday, October 13').click();
  await ap.click('#day-panel button:has-text("Day off")');
  await ap.waitForFunction(() => /No school/.test(document.querySelector('#month .mday[aria-label^="Tuesday, October 13:"]').getAttribute('aria-label')));
  await ap.fill('#day-panel input', 'In-service'); await ap.click('#day-panel button:has-text("Save name")');
  await ap.waitForFunction(() => /In-service/.test(document.querySelector('#noschool-list').innerText));
  step('calendar: weekday pattern, a break, a special day, a custom schedule from Infinite Campus, a day off; the month updates');
  // a tool added on the Admin page shows in the Tools section of Links
  await ap.click('#tabs [data-tab="links"]');
  await ap.waitForSelector('#tools-list .list-row');
  await ap.click('#tools-add');
  await ap.locator('#dlg').getByLabel('Name', { exact: true }).fill('GPA calculator');
  await ap.locator('#dlg').getByLabel('Web address (empty = coming soon)').fill('https://gpa.example.test/');
  await ap.locator('#dlg').getByLabel('What it does').fill('Work out your GPA');
  await ap.click('#dlg button[type=submit]');
  await ap.waitForFunction(() => /GPA calculator/.test(document.querySelector('#tools-list').innerText));
  assert.equal(await ap.locator('#dlg').isVisible(), false, 'the dialog closes after saving');
  await ap.screenshot({ path: path.join(SHOTS, 'admin.png'), fullPage: true });
  await ap.goto(base + '/links.html'); await ap.waitForSelector('#tools .link-card');
  assert.match(await text(ap, 'h1'), /^Links$/);
  assert.deepEqual((await ap.locator('#tools .link-card strong').allInnerTexts()), ['Class Cards', 'GPA calculator']);
  assert.equal(await ap.locator('#tools a.link-card').getAttribute('href'), 'https://gpa.example.test/');
  step('tools: added in Admin → Links & tools, shown in the Tools section of Links');

  // ---------------------------------------------------------------- two students
  const ann = await newUser('ann', { sub: 's1', email: 'ann@school.test', given_name: 'Ann', family_name: 'Lee' });
  const ben = await newUser('ben', { sub: 's2', email: 'ben@school.test', given_name: 'Ben', family_name: 'Ray' }, { viewport: { width: 390, height: 844 }, isMobile: true });
  await signIn(ann, 'schedule.html');
  assert.match(ann.page.url(), /schedule\.html$/);
  step('sign-in returned to the page the student wanted');
  const sp = ann.page;
  // one row per color block plus Advisory; Day A runs Yellow, Red, Pink, Green, Purple, Silver
  await sp.waitForSelector('#blocks [data-block="yellow"][data-field="name"]');
  assert.equal(await sp.locator('#blocks [data-field="name"]').count(), 9);
  const field = (block, f) => `#blocks [data-block="${block}"][data-field="${f}"]`;
  const fillBlock = async (block, name, teacher, room, lunch) => {
    await sp.fill(field(block, 'name'), name);
    if (teacher) await sp.fill(field(block, 'teacher'), teacher);
    if (room) await sp.fill(field(block, 'room'), room);
    if (lunch) await sp.selectOption(field(block, 'lunch'), lunch);
  };
  // the lunch picker is only on the Hour 4 blocks: Green (Day A) and Orange (Days B-D)
  assert.deepEqual(await sp.locator('#blocks [data-field="lunch"]').evaluateAll((els) => els.map((e) => e.dataset.block)), ['green', 'orange']);
  assert.deepEqual(await sp.locator(field('green', 'lunch') + ' option').evaluateAll((els) => els.map((e) => e.value)), ['', 'A', 'B', 'C']);
  assert.match(await text(sp, '#lunch-help'), /Green[\s\S]*Day A[\s\S]*Orange[\s\S]*Day B, Day C, Day D/);
  await fillBlock('yellow', 'English 10', 'Ms. Quill', '110');
  await fillBlock('red', 'Algebra II', 'Mr. Sum', '204');
  await fillBlock('pink', 'Chemistry', 'Dr. Mole', '305');
  await fillBlock('green', 'Spanish 2', 'Sra. Sol', '118', 'B');
  await fillBlock('orange', 'Health', 'Mr. Fit', '120', 'C');
  await sp.fill(field('purple', 'name'), '<img src=x onerror="window.__xss=1">');
  await sp.fill(field('advisory', 'teacher'), 'Erin Cuellar'); await sp.fill(field('advisory', 'room'), '119'); // no name: "Advisory"
  assert.match(await text(sp, '#save-state'), /Unsaved/);
  // the rotation grid follows what's typed: Pink is Hour 3 on Days A-C, Blue (unset) on Day D
  const gridRow = (hour) => sp.locator(`#rotation tbody tr:nth-child(${hour}) td`);
  assert.deepEqual((await gridRow(3).allInnerTexts()).map((t) => t.split('\n')[0]), ['Chemistry', 'Chemistry', 'Chemistry', 'Blue']);
  assert.match((await gridRow(4).allInnerTexts())[0], /Spanish 2[\s\S]*Green · B Lunch/);
  assert.match((await gridRow(4).allInnerTexts())[1], /Health[\s\S]*Orange · C Lunch/);
  await sp.click('#save-btn');
  await sp.waitForFunction(() => document.querySelector('#save-state').innerText === '');
  await sp.reload(); await sp.waitForSelector(field('yellow', 'name'));
  assert.equal(await sp.inputValue(field('pink', 'name')), 'Chemistry');
  assert.equal(await sp.inputValue(field('red', 'teacher')), 'Mr. Sum');
  assert.equal(await sp.inputValue(field('green', 'lunch')), 'B');
  assert.equal(await sp.inputValue(field('orange', 'lunch')), 'C');
  assert.deepEqual([await sp.inputValue(field('advisory', 'name')), await sp.inputValue(field('advisory', 'room'))], ['Advisory', '119']);
  assert.equal(await sp.inputValue(field('purple', 'name')), '<img src=x onerror="window.__xss=1">');
  assert.equal(await sp.evaluate(() => window.__xss), undefined, 'class names never execute as HTML');
  assert.equal(await sp.locator('#rotation img').count(), 0);
  // Clear all empties every block but saves nothing until Save
  await sp.click('#clear-btn');
  assert.equal(await sp.inputValue(field('pink', 'name')), '');
  assert.equal(await sp.inputValue(field('green', 'lunch')), '');
  assert.match(await text(sp, '#save-state'), /Unsaved/);
  await sp.reload(); await sp.waitForSelector(field('yellow', 'name'));
  assert.equal(await sp.inputValue(field('pink', 'name')), 'Chemistry');
  await sp.screenshot({ path: path.join(SHOTS, 'schedule.png'), fullPage: true });
  step('schedule: fill blocks + lunch, grid follows, save, reload persisted, clear all unsaved; HTML in a class name stays text');

  // dashboard with live status (Thu 10:00 AM = Hour 3)
  await sp.goto(base + '/index.html');
  await sp.waitForSelector('#setup-card:not([hidden])');
  assert.match(await text(sp, '#setup-card'), /Get set up[\s\S]*1 of 2 done[\s\S]*Add your classes[\s\S]*Add a friend/);
  assert.equal(await sp.locator('#setup-card li.done').count(), 1, 'classes are done');
  await sp.waitForSelector('#schedule-body tr.period-row.current');
  const status = await text(sp, '#status');
  step('dashboard now-card: ' + status.replace(/\n+/g, ' | '));
  assert.match(status, /Hour 3 · \d+ min left/);
  assert.match(status, /Chemistry \(Rm 305\)/);
  assert.match(status, /Next: Hour 4 \(\+ Lunch\) – Spanish 2 \(Rm 118\) at 10:56 AM/);
  assert.match(await text(sp, '#day-head'), /Thursday, October 1[\s\S]*Day A/);
  assert.match(await text(sp, '#schedule-body tr.current'), /Hour 3[\s\S]*9:44 AM – 10:51 AM[\s\S]*MTV & Announcements until 9:49 AM[\s\S]*Chemistry/);
  // Hour 4 on Day A is Green, so it shows Green's B Lunch time
  assert.match(await text(sp, '#schedule-body tr[data-hour="4"]'), /Spanish 2[\s\S]*Green[\s\S]*B Lunch 11:31 AM – 11:56 AM/);
  assert.equal(await sp.evaluate(() => window.__xss), undefined);
  await sp.screenshot({ path: path.join(SHOTS, 'dashboard-ann.png'), fullPage: true });
  // next school day: Fri 10/2 (Day B, Hour 4 = Orange, C Lunch) then skips the break to Thu 10/8 (Day C)
  await sp.click('button[aria-label="Next school day"]');
  assert.match(await text(sp, '#day-head'), /Friday, October 2[\s\S]*Day B/);
  assert.match(await text(sp, '#schedule-body tr[data-hour="4"]'), /Health[\s\S]*Orange[\s\S]*C Lunch 12:06 PM – 12:31 PM/);
  await sp.click('button[aria-label="Next school day"]');
  assert.match(await text(sp, '#day-head'), /Thursday, October 8[\s\S]*Day C/);
  await sp.click('button[aria-label="Next school day"]');
  assert.match(await text(sp, '#day-head'), /Friday, October 9[\s\S]*Early release/);
  assert.match(await text(sp, '#schedule-body tr[data-hour="4"]'), /Health[\s\S]*C Lunch 10:44 AM – 11:09 AM/); // early release lunch times
  assert.equal(await sp.locator('#status').isHidden(), true);
  await sp.click('button:has-text("Back to today")');
  assert.match(await text(sp, '#day-head'), /Thursday, October 1/);
  // two weeks at a glance: this week (Mon 9/28 - Fri 10/2) and next (fall break 10/5-7, early release 10/9)
  const weeks = (await sp.locator('#weeks .wk-day').allInnerTexts()).map((t) => t.replace(/\s*\n\s*/g, ' ').trim());
  assert.deepEqual(weeks, ['Mon 9/28 B', 'Tue 9/29 C', 'Wed 9/30 D Advisory', 'Thu 10/1 A', 'Fri 10/2 B',
    'Mon 10/5 – Fall break', 'Tue 10/6 – Fall break', 'Wed 10/7 – Fall break', 'Thu 10/8 C', 'Fri 10/9 D Early rel.']);
  assert.equal(await sp.locator('#weeks .wk-day.today').innerText().then((t) => t.split('\n')[0]), 'Thu 10/1');
  await sp.click('#weeks button:has-text("10/8")');
  assert.match(await text(sp, '#day-head'), /Thursday, October 8[\s\S]*Day C/);
  assert.equal(await sp.locator('#weeks .wk-day.viewing').count(), 1);
  await sp.click('button:has-text("Back to today")');
  await sp.click('button[aria-label="Previous school day"]'); // Wednesday = Advisory day
  assert.match(await text(sp, '#schedule-body tr[data-hour="advisory"]'), /Advisory[\s\S]*10:36 AM – 11:06 AM[\s\S]*Advisory · Rm 119[\s\S]*Erin Cuellar/);
  await sp.click('button:has-text("Back to today")');
  await sp.screenshot({ path: path.join(SHOTS, 'dashboard-weeks.png'), fullPage: true });
  step('day navigation skips the break; special schedule shown; advisory row; two-week calendar opens a day; back to today works');

  // ---------------------------------------------------------------- assignments: classmates' tests; Google Tasks "coming soon"
  await sp.goto(base + '/classwork.html'); await sp.waitForSelector('#class-card:not([hidden])');
  assert.match(await text(sp, '#soon-card'), /Coming soon/);
  assert.equal(await sp.locator('#connect-card').isHidden(), true);
  await sp.click('#class-add summary');
  await sp.selectOption('#ce-block', 'pink'); await sp.selectOption('#ce-kind', 'quiz');
  await sp.fill('#ce-title', 'Moles quiz'); await sp.fill('#ce-due', '2026-10-02');
  await sp.click('#class-form button[type=submit]');
  await sp.waitForSelector('#class-items .list-row:has-text("Moles quiz")');
  assert.match(await text(sp, '#class-items'), /Quiz[\s\S]*Moles quiz[\s\S]*Chemistry · Due tomorrow/);
  assert.equal(await sp.locator('#study-card').isVisible(), true, 'study sessions still work');
  await sp.screenshot({ path: path.join(SHOTS, 'assignments.png'), fullPage: true });
  await sp.goto(base + '/index.html'); await sp.waitForSelector('#tasks-preview .list-row');
  assert.match(await text(sp, '#tasks-preview'), /Quiz[\s\S]*Moles quiz[\s\S]*Due tomorrow · Chemistry/);
  assert.match(await text(sp, '#schedule-body tr[data-hour="3"]'), /Chemistry[\s\S]*Quiz Moles quiz · tomorrow/);
  step('assignments: a classmate quiz added for Chemistry shows on Assignments, Due soon and next to the class; Google Tasks "coming soon"');

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
  await bp.waitForFunction(() => /Ann L\.[\s\S]*Request sent/.test(document.querySelector('#requests').innerText));
  step('invite link: sign in -> confirm -> request sent');
  await sp.reload(); await sp.waitForSelector('#requests button:has-text("Accept")');
  assert.match(await text(sp, '#requests'), /Ben R\.\s*wants to be friends/);
  await sp.click('#requests button:has-text("Accept")');
  await sp.waitForFunction(() => /Ben R\./.test(document.querySelector('#friends').innerText));
  await sp.screenshot({ path: path.join(SHOTS, 'friends.png'), fullPage: true });
  // a wrong code gives a clear message, a malformed one too
  await sp.fill('#friend-code', 'AAAAA-AAAAA'); await sp.click('#find-form button');
  await sp.waitForSelector('#confirm-box.error');
  assert.match(await text(sp, '#confirm-box'), /No one has that code/);
  // Ben's Red block is Ann's Algebra (same class, different case), his Pink isn't, and he shares her B Lunch
  await bp.goto(base + '/schedule.html'); await bp.waitForSelector('#blocks [data-block="red"][data-field="name"]');
  await bp.fill('#blocks [data-block="red"][data-field="name"]', 'algebra ii');
  await bp.fill('#blocks [data-block="red"][data-field="teacher"]', 'Mr. Sum');
  await bp.fill('#blocks [data-block="pink"][data-field="name"]', 'Physics');
  await bp.fill('#blocks [data-block="pink"][data-field="room"]', '301');
  await bp.fill('#blocks [data-block="green"][data-field="name"]', 'Art');
  await bp.selectOption('#blocks [data-block="green"][data-field="lunch"]', 'B');
  await bp.click('#save-btn'); await bp.waitForFunction(() => document.querySelector('#save-state').innerText === '');
  await bp.goto(base + '/index.html'); await bp.waitForSelector('#schedule-body tr.current');
  assert.match(await text(bp, '#friends-preview'), /Ann L\.[\s\S]*Chemistry · Rm 305/);
  assert.match(await text(bp, '#schedule-body'), /Algebra/i);
  assert.match(await text(bp, '#schedule-body tr[data-hour="2"]'), /With Ann L\./);
  assert.doesNotMatch(await text(bp, '#schedule-body tr[data-hour="3"]'), /With/);
  assert.match(await text(bp, '#schedule-body tr[data-hour="4"]'), /Art[\s\S]*B Lunch 11:31 AM – 11:56 AM/);
  assert.doesNotMatch(await text(bp, '#schedule-body tr[data-hour="4"]'), /Lunch with/, 'no lunch-buddy list on Today');
  await bp.screenshot({ path: path.join(SHOTS, 'dashboard-ben-mobile.png'), fullPage: true });
  step('friends: accepted; friend shown in current class; shared-class and shared-lunch hints on matching hours only');

  // ---------------------------------------------------------------- events + XSS
  // posting is for admins and verified people by default: Ann can't until the admin verifies her
  const ep = ann.page;
  await ep.goto(base + '/events.html'); await ep.waitForSelector('#add-card:not([hidden])');
  assert.equal(await ep.locator('#add-card').getAttribute('open'), null, 'the form is tucked away until you want it');
  await ep.click('#add-card summary');
  // unverified: only private events for friends; no "Everyone" choice
  assert.equal(await ep.locator('#ev-visibility option[value="public"]').count(), 0);
  assert.match(await text(ep, '#post-note'), /admins, verified people/);
  await ap.goto(base + '/admin.html#people'); await ap.waitForSelector('#users .person-card');
  await ap.click('#users .person-card[aria-label^="Ann L."]');
  await ap.click('#dlg button[aria-label="Verify Ann L."]');
  await ap.waitForSelector('.toast:has-text("Ann L. can now post events")');
  await ap.keyboard.press('Escape');
  assert.match(await text(ap, '#users .person-card[aria-label^="Ann L."]'), /verified/);
  step('events: unverified student cannot post; admin verifies Ann');
  await ep.reload(); await ep.waitForSelector('#ev-visibility option[value="public"]', { state: 'attached' });
  await ep.click('#add-card summary');
  assert.equal(await ep.locator('#ev-limit').isHidden(), true, 'spots only with a sign-up list');
  await ep.selectOption('#ev-visibility', 'public');
  await ep.fill('#title', '<img src=x onerror="window.__xss2=1"> Pep rally');
  await ep.fill('#date', '2026-10-03'); await ep.fill('#time', '14:30'); await ep.fill('#description', '<script>window.__xss3=1</script>Gym');
  await ep.click('#event-form button[type=submit]');
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
  await sp.fill('#name', 'Annie'); await sp.click('#profile-save');
  await sp.waitForFunction(() => (document.querySelector('.nav-me').getAttribute('aria-label') || '').includes('Annie')); // (the name itself shows on wide screens)
  assert.equal(await sp.locator('body > .tabbar').count(), 1, 'drawing the nav again replaces the tab bar');
  assert.match(await text(sp, '#hero'), /Annie/, 'the profile header follows the new name');
  assert.deepEqual(await sp.locator('#profile-tabs a').allInnerTexts(), ['Profile', 'My classes', 'Privacy', 'Notifications & calendar', 'Account']);
  await sp.click('#profile-tabs a:has-text("Privacy")');
  await sp.waitForSelector('#sec-privacy:not([hidden])');
  assert.equal(await sp.locator('#sec-profile').isHidden(), true, 'one section at a time');
  await sp.uncheck('#share');
  await sp.waitForSelector('.toast:has-text("hidden from all friends")');
  await bp.goto(base + '/friends.html');
  await bp.waitForFunction(() => /Schedule hidden/.test(document.querySelector('#friends').innerText));
  assert.match(await text(bp, '#friends'), /Annie/);
  await sp.click('#profile-tabs a:has-text("My classes")'); await sp.waitForURL(/schedule\.html/);
  assert.equal(await sp.locator('#profile-tabs a.active').innerText(), 'My classes');
  step('profile: sections (My classes is part of it); rename shows in the nav; privacy switch hides the schedule from friends');

  // ---------------------------------------------------------------- a profile photo: shrunk in the page, approved by an admin
  await sp.goto(base + '/account.html'); await sp.waitForSelector('#photo-status');
  await sp.setInputFiles('#photo-file', path.join(R, 'public', 'app-icon-512.png'));
  // place it: zoom in, drag it a little, then use it
  await sp.waitForSelector('.crop-dialog[open] .crop-stage');
  await sp.locator('.crop-dialog input[type=range]').fill('1.5');
  const stage = await sp.locator('.crop-stage').boundingBox();
  await sp.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2); await sp.mouse.down();
  await sp.mouse.move(stage.x + stage.width / 2 + 30, stage.y + stage.height / 2 + 20, { steps: 4 }); await sp.mouse.up();
  await sp.click('.crop-dialog button:has-text("Use this photo")');
  await sp.waitForSelector('#photo-status:has-text("Waiting for an admin")');
  const pendingSrc = await sp.locator('#photo-status img').getAttribute('src');
  assert.match(pendingSrc, /^\/photos\/[0-9a-f]{32}\.jpg$/);
  const shrunk = await sp.evaluate(async (src) => { const b = await (await fetch(src)).blob(); const i = await createImageBitmap(b); return [b.type, i.width, i.height]; }, pendingSrc);
  assert.deepEqual(shrunk, ['image/jpeg', 256, 256], 'resized to a 256×256 JPEG before upload');
  await ap.goto(base + '/admin.html#review'); await ap.waitForSelector('#photo-queue .photo-item');
  await ap.click('#photo-queue button[aria-label="Approve Annie\'s photo"]');
  await ap.waitForSelector('.toast:has-text("Approved")');
  await bp.goto(base + '/friends.html'); await bp.waitForSelector('#friends img.avatar.photo');
  step('profile photo: placed and zoomed, uploaded (256×256), approved in Admin → Review, friends see it');

  // ---------------------------------------------------------------- feedback, answered in the app; the audit log
  await sp.goto(base + '/feedback.html'); await sp.waitForSelector('#feedback-form');
  await sp.click('.choice:has-text("An idea")'); // the tile is the choice
  assert.equal(await sp.locator('input[name="type"][value="idea"]').isChecked(), true);
  await sp.fill('#fb-message', 'Could Today show bus changes?');
  await sp.click('#feedback-form button[type=submit]');
  await sp.waitForSelector('#mine .feedback-item');
  assert.match(await text(sp, '#mine'), /An idea[\s\S]*Sent[\s\S]*Could Today show bus changes\?/);
  await ap.goto(base + '/admin.html#feedback'); await ap.waitForSelector('#fb-list .feedback-item');
  assert.match(await text(ap, '#count-feedback'), /^1$/);
  await ap.fill('#fb-list textarea', 'Good idea! We\'re on it.');
  await ap.click('#fb-list button:has-text("Send reply")');
  await ap.waitForSelector('.toast:has-text("Reply sent")');
  await sp.goto(base + '/index.html'); await sp.waitForSelector('#day-head .notice:has-text("We answered your feedback")');
  await sp.click('#day-head a[href="feedback.html"]');
  await sp.waitForSelector('#mine .reply');
  assert.match(await text(sp, '#mine .reply'), /Ada M\.[\s\S]*Good idea! We're on it\./);
  await ap.click('#tabs [data-tab="audit"]'); await ap.waitForSelector('#audit-rows tr');
  assert.match(await text(ap, '#audit-rows'), /Replied to feedback[\s\S]*Sent feedback/);
  await ap.fill('#audit-q', 'bus changes'); await ap.click('#audit-form button');
  await ap.waitForFunction(() => document.querySelectorAll('#audit-rows tr').length === 1);
  step('feedback: sent, answered in Admin, reply shown on Today and Feedback; audit log lists and searches it');
  await sp.screenshot({ path: path.join(SHOTS, 'account.png'), fullPage: true });

  // ---------------------------------------------------------------- backup + restore through the UI
  await ap.goto(base + '/admin.html#backup'); await ap.waitForSelector('#users .person-card', { state: 'attached' });
  assert.equal(await ap.locator('#users .person-card').count(), 3);
  const [download] = await Promise.all([ap.waitForEvent('download'), ap.click('#backup-link')]);
  const backupPath = path.join(SHOTS, 'backup.json');
  await download.saveAs(backupPath);
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(backup.users.length, 3);
  // a student leaves; the admin then restores the backup and gets them back
  const carl = await newUser('carl', { sub: 's3', email: 'carl@school.test', given_name: 'Carl', family_name: 'Fox' });
  await signIn(carl);
  await carl.page.goto(base + '/account.html#account'); await carl.page.waitForSelector('#sec-account:not([hidden])');
  await carl.page.fill('#confirm-delete', 'delete'); await carl.page.click('#delete-btn');
  await carl.page.waitForURL(/index\.html$/);
  assert.equal(Object.keys(ctx.app.state.users).length, 3);
  await ap.reload(); await ap.waitForSelector('#users .person-card', { state: 'attached' });
  await ap.setInputFiles('#restore-file', backupPath);
  assert.equal(await ap.locator('#restore-btn').isDisabled(), true);
  await ap.fill('#restore-confirm', 'RESTORE');
  await ap.click('#restore-btn');
  await ap.waitForSelector('.toast:has-text("Restored 3 people and 0 events")');
  await ap.waitForLoadState('load'); await ap.waitForSelector('#users .person-card', { state: 'attached' });   // the page reloads itself after a restore
  assert.equal(await ap.locator('#users .person-card').count(), 3);
  assert.equal(Object.keys(ctx.app.state.users).length, 3);
  step('backup downloaded; account deleted; restore through the UI brought everyone back');

  // ---------------------------------------------------------------- phones: no sideways scrolling anywhere
  const phone = await newUser('phone', { sub: 'a1', email: 'admin@school.test', given_name: 'Ada', family_name: 'Min' }, { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  await signIn(phone);
  for (const pg of ['index', 'schedule', 'classwork', 'lunch', 'events', 'calendar', 'groups', 'friends', 'links', 'account', 'admin', 'login', 'feedback', 'terms', 'about']) {
    await phone.page.goto(`${base}/${pg}.html`);
    await phone.page.waitForLoadState('networkidle');
    await phone.page.waitForTimeout(250);
    const w = await phone.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
    if (w.scroll > w.view) {
      const culprit = await phone.page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 4).map((e) => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)));
      problems.push(`[phone] ${pg}.html scrolls sideways (${w.scroll} > ${w.view}): ${culprit.join(', ')}`);
    }
    if (['index', 'schedule', 'classwork', 'groups', 'friends', 'admin'].includes(pg)) await phone.page.screenshot({ path: path.join(SHOTS, `phone-${pg}.png`), fullPage: true });
  }
  step('phone layout checked on every page');
  // phones get a tab bar at the bottom; "More" opens the other pages, Escape or a tap outside closes it
  const pp = phone.page;
  await pp.goto(base + '/index.html'); await pp.waitForSelector('.tabbar');
  assert.equal(await pp.locator('.nav-wide').isHidden(), true);
  assert.deepEqual(await pp.locator('.tabbar .tab').allInnerTexts(), ['Today', 'Assignments', 'Events', 'Friends', 'More']);
  assert.equal(await pp.locator('.tabbar a.active').innerText(), 'Today');
  await pp.click('.tabbar button.tab');
  assert.equal(await pp.locator('.tabbar button.tab').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await pp.locator('#more-sheet a, #more-sheet button').allInnerTexts(), ['Calendar', 'Groups', 'Lunch', 'Links', 'Profile & my classes', 'Feedback', 'Admin', 'Sign out']);
  await pp.keyboard.press('Escape');
  assert.equal(await pp.locator('#more-sheet').isHidden(), true);
  await pp.click('.tabbar button.tab'); await pp.click('#more-sheet a:has-text("Groups")');
  await pp.waitForURL(/groups\.html/);
  assert.match(await pp.locator('.tabbar button.tab').getAttribute('class'), /active/, 'More is lit on its pages');
  await pp.click('.tabbar button.tab'); await pp.click('#more-sheet a:has-text("Profile & my classes")'); await pp.waitForURL(/account\.html/);
  await pp.click('#profile-tabs a:has-text("My classes")'); await pp.waitForURL(/schedule\.html/);
  await pp.fill('#blocks [data-block="yellow"][data-field="room"]', '999');
  assert.equal(await pp.locator('#save-bar').evaluate((e) => getComputedStyle(e).position), 'sticky', 'Save stays in view with unsaved changes');
  step('phone: tab bar, More sheet (Escape closes, active page lit), profile → My classes, sticky Save');

  // ---------------------------------------------------------------- a teacher
  const tea = await newUser('teacher', { sub: 'teach-1', email: 'wienke@school.test', given_name: 'Jason', family_name: 'Wienke' });
  await signIn(tea, null, 'teacher');
  assert.deepEqual(await tea.page.locator('.nav-wide a').allInnerTexts(), ['Today', 'Lesson plans', 'Groups']);
  await tea.page.goto(base + '/friends.html'); await tea.page.waitForURL(/index\.html/);
  await tea.page.goto(base + '/schedule.html'); await tea.page.waitForSelector('[data-block="red"][data-field="name"]');
  assert.equal(await tea.page.locator('[data-field="teacher"], [data-field="room"], #import-card').count(), 0, 'class names only');
  await tea.page.fill('[data-block="red"][data-field="name"]', 'Machine Tool I');
  await tea.page.click('#save-btn'); await tea.page.waitForSelector('.toast:has-text("Schedule saved")');
  await tea.page.goto(base + '/index.html'); await tea.page.waitForSelector('#schedule-body tr');
  assert.match(await text(tea.page, '#schedule-body'), /Machine Tool I/);
  assert.equal(await tea.page.locator('#friends-card').isVisible(), false);
  // a lesson plan for the first class that meets this week
  await tea.page.goto(base + '/plans.html'); await tea.page.waitForSelector('.plan-day textarea');
  await tea.page.locator('.plan-day textarea').first().fill('Lathe safety quiz');
  await tea.page.waitForSelector('.plan-state:has-text("Saved")');
  assert.equal((await tea.page.evaluate(() => fetch('/api/plans').then((r) => r.json()))).length, 1);
  step('teacher: picked at sign-up; Today, Lesson plans and Groups only; classes without room or teacher; a lesson plan saved as they type');

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
