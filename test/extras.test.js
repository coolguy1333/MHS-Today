'use strict';
// Announcements and countdowns, the word filter, calendar sync, group boards and polls, study
// sessions, and push notifications with reminders.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cal = require('../public/js/calendar.js');
const webpush = require('../src/webpush');
const { createFilter } = require('../src/wordfilter');
const { startApp, closeAll, user } = require('./helpers');
const { startMockGoogle } = require('./mock-google');

let mock;
test.before(async () => { mock = await startMockGoogle(); });
test.after(async () => { await mock.close(); });
test.afterEach(closeAll);

async function as(ctx, n, extra) {
  const c = ctx.client();
  assert.equal((await c.signIn(mock, user(n, extra))).status, 302);
  return c;
}
const owner = (ctx) => as(ctx, 99, { email: 'admin@school.test', given_name: 'Ada' });
const today = () => cal.schoolNow('America/Chicago').date;
const day = (n) => cal.addDays(today(), n);

// ---------------------------------------------------------------- notices

test('notices: admins set announcements and countdowns; everyone sees the current ones', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const kid = await as(ctx, 1);
  assert.equal((await kid.put('/api/admin/notices', { announcements: [] })).status, 403);
  for (const bad of [{ announcements: [{ text: '', start: day(0), end: day(1) }] }, { announcements: [{ text: 'x', start: day(2), end: day(1) }] },
    { countdowns: [{ title: 'x', date: 'soon' }] }, { blockedWords: 'x' }]) {
    assert.equal((await boss.put('/api/admin/notices', bad)).status, 400, JSON.stringify(bad));
  }
  await boss.put('/api/admin/notices', {
    announcements: [
      { text: 'Snow day: no school', start: day(0), end: day(0), urgent: true },
      { text: 'Next week', start: day(7), end: day(8) },
      { text: 'Over', start: day(-5), end: day(-1) }],
    countdowns: [{ title: 'Winter break', date: day(30) }, { title: 'Finals', date: day(10) }, { title: 'Past', date: day(-2) }]
  });
  const n = (await ctx.client().get('/api/notices')).data;
  assert.deepEqual(n.announcements.map((a) => [a.text, a.urgent]), [['Snow day: no school', true]]);
  assert.deepEqual(n.countdowns.map((c) => c.title), ['Finals', 'Winter break']);
});

// ---------------------------------------------------------------- word filter

test('word filter: catches disguised words but not innocent ones, plus admin words', async () => {
  const f = createFilter(() => ['badword']);
  for (const ok of ['assess', 'Scunthorpe', 'cocktail', 'Dickens', 'therapist', 'Hancock', 'pass', 'wow!!', 'Classic 8']) assert.equal(f.find(ok), null, ok);
  for (const no of ['shit', 'sh1t', '$hit', 'sh!t', 'f u c k', 'FUUUCK', 'shithead', 'bitches', 'BADWORD!!', 'b@dword']) assert.notEqual(f.find(no), null, no);

  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const kid = await as(ctx, 1);
  const r = await kid.put('/api/me', { bio: 'I love sh1t' });
  assert.equal(r.status, 400); assert.match(r.data.error, /school-appropriate/);
  assert.equal((await kid.post('/api/events', { title: 'f u c k', date: day(1) })).status, 400);
  assert.equal((await kid.post('/api/groups', { name: 'Bitches club', kind: 'club', joinPolicy: 'open' })).status, 400);
  assert.equal((await kid.post('/api/tools/suggestions', { name: 'shitty tool' })).status, 400);
  assert.equal((await kid.put('/api/me', { bio: 'Our mascot rocks' })).status, 200);
  await boss.put('/api/admin/notices', { blockedWords: ['Mascot', ' '] });
  assert.deepEqual((await boss.get('/api/admin/notices')).data.blockedWords, ['mascot']);
  assert.equal((await kid.put('/api/me', { bio: 'Our mascot rocks' })).status, 400, 'admin words apply');
});

// ---------------------------------------------------------------- calendar sync

test('calendar: a private feed link with my events, study sessions and no-school days', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  await ann.put('/api/classes', { yellow: { name: 'Algebra II' } });
  await ben.put('/api/classes', { yellow: { name: 'Algebra II' } });
  await boss.post('/api/events', { title: 'Public game', date: day(3), time: '19:00' });
  await boss.post('/api/events', { title: 'Car wash', date: day(4), time: '09:30', signup: true });
  const carWash = (await ann.get('/api/events')).data.find((e) => e.title === 'Car wash');
  await ann.post(`/api/events/${carWash.id}/signup`, { on: true });
  await ann.post('/api/study', { block: 'yellow', title: 'Quiz prep; ch. 1, 2', date: day(1), time: '15:00', place: 'Library' });
  await boss.put('/api/admin/calendar', { noSchool: { [day(5)]: 'Fall break' } });

  assert.deepEqual((await ann.get('/api/me/calendar')).data, { url: null });
  const { url } = (await ann.post('/api/me/calendar')).data;
  assert.match(url, /\/cal\/[0-9a-f]{48}\.ics$/);
  const path = new URL(url).pathname;
  const res = await ctx.client().raw('GET', path, { xhr: false });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/calendar/);
  const ics = await res.text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:Car wash/);
  assert.match(ics, /SUMMARY:Study: Quiz prep\\; ch\. 1\\, 2 \(Algebra II\)/, 'text is escaped');
  assert.match(ics, new RegExp(`DTSTART;VALUE=DATE:${day(5).replace(/-/g, '')}`), 'no-school days are all-day events');
  assert.match(ics, /SUMMARY:No school: Fall break/);
  assert.doesNotMatch(ics, /Public game/, 'only events that are yours');
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines are folded');
  // the event time is converted from school time to UTC
  const start = /SUMMARY:Car wash/.test(ics) && ics.split('BEGIN:VEVENT').find((v) => v.includes('Car wash')).match(/DTSTART:(\d{8}T\d{6}Z)/)[1];
  const local = cal.schoolNow('America/Chicago', new Date(start.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')));
  assert.deepEqual([local.date, local.minutes], [day(4), 9 * 60 + 30]);

  // replacing the link kills the old one; turning it off too
  const { url: url2 } = (await ann.post('/api/me/calendar')).data;
  assert.notEqual(url2, url);
  assert.equal((await ctx.client().raw('GET', path, { xhr: false })).status, 404);
  await ann.del('/api/me/calendar');
  assert.equal((await ctx.client().raw('GET', new URL(url2).pathname, { xhr: false })).status, 404);
  assert.equal((await ctx.client().raw('GET', '/cal/nope.ics', { xhr: false })).status, 404);
});

test('calendar: every school day is an event from 7:00 to the last bell, titled with the day letter', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1);
  const c0 = cal.emptyCalendar();
  const d0 = cal.dayInfo(c0, today()).schoolDay ? today() : cal.nextSchoolDay(c0, today());
  const d1 = cal.nextSchoolDay(c0, d0);
  const d2 = cal.nextSchoolDay(c0, d1);
  await boss.put('/api/admin/calendar', { anchorDate: d0, anchorLetter: 'B', types: { [d1]: 'early_release', [d2]: 'advisory' } });
  const { url } = (await ann.post('/api/me/calendar')).data;
  const ics = await (await ctx.client().raw('GET', new URL(url).pathname, { xhr: false })).text();
  const events = ics.split('BEGIN:VEVENT').slice(1);
  const ev = (date) => events.find((v) => v.includes(`UID:day-${date}@mhs-hub`));
  const local = (v, field) => {
    const stamp = v.match(new RegExp(`${field}:(\\d{8}T\\d{6}Z)`))[1];
    const n = cal.schoolNow('America/Chicago', new Date(stamp.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')));
    return `${n.date} ${String(Math.floor(n.minutes / 60)).padStart(2, '0')}:${String(Math.round(n.minutes % 60)).padStart(2, '0')}`;
  };
  assert.match(ev(d0), /SUMMARY:Day B\r\n/);
  assert.equal(local(ev(d0), 'DTSTART'), `${d0} 07:00`);
  assert.equal(local(ev(d0), 'DTEND'), `${d0} 14:45`);
  assert.match(ev(d1), /SUMMARY:Day C · Early release\r\n/);
  assert.equal(local(ev(d1), 'DTEND'), `${d1} 12:45`, 'early release ends at 12:45');
  assert.match(ev(d2), /SUMMARY:Day D · Advisory day\r\n/);
  assert.equal(local(ev(d2), 'DTEND'), `${d2} 14:45`);
  // no events on weekends or no-school days
  const sat = [0, 1, 2, 3, 4, 5, 6].map((i) => cal.addDays(d0, i)).find((d) => new Date(cal.parseDate(d)).getUTCDay() === 6);
  assert.equal(ev(sat), undefined);
  await boss.put('/api/admin/calendar', { anchorDate: d0, anchorLetter: 'B', noSchool: { [d1]: 'Teacher day' } });
  const ics2 = await (await ctx.client().raw('GET', new URL(url).pathname, { xhr: false })).text();
  assert.doesNotMatch(ics2, new RegExp(`UID:day-${d1}@`));
  assert.match(ics2.split('BEGIN:VEVENT').find((v) => v.includes(`UID:day-${d2}@`)), /SUMMARY:Day C\r\n/, 'the letter skips the day off');
});

// ---------------------------------------------------------------- group board and polls

test('group board: members post and reply, leaders announce and run polls', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const lead = await as(ctx, 1, { given_name: 'Lea' });
  const mem = await as(ctx, 2, { given_name: 'Max' });
  const out = await as(ctx, 3, { given_name: 'Oz' });
  const gid = (await lead.post('/api/groups', { name: 'Robotics', kind: 'club', joinPolicy: 'open' })).data.id;
  await boss.put(`/api/admin/groups/${gid}`, { approved: true });
  await mem.post(`/api/groups/${gid}/join`);

  assert.equal((await out.get(`/api/groups/${gid}/board`)).status, 403, 'members only');
  assert.equal((await mem.post(`/api/groups/${gid}/posts`, { text: 'Meeting moved?', announcement: true })).status, 403, 'only leaders announce');
  assert.equal((await mem.post(`/api/groups/${gid}/posts`, { text: '  ' })).status, 400);
  assert.equal((await mem.post(`/api/groups/${gid}/posts`, { text: 'This is shit' })).status, 400, 'word filter');
  let b = (await mem.post(`/api/groups/${gid}/posts`, { text: 'Who has the 3D printer key?\nAsking for a friend' })).data;
  const pid = b.posts[0].id;
  assert.equal(b.posts[0].text, 'Who has the 3D printer key?\nAsking for a friend', 'line breaks are kept');
  await lead.post(`/api/groups/${gid}/posts/${pid}/replies`, { text: 'I do' });
  b = (await lead.post(`/api/groups/${gid}/posts`, { text: 'Competition is Saturday!', announcement: true })).data;
  assert.deepEqual(b.posts.map((p) => [p.text.slice(0, 11), p.announcement]), [['Competition', true], ['Who has the', false]], 'announcements first');
  assert.deepEqual(b.posts[1].replies.map((r) => [r.text, r.by.name]), [['I do', 'Lea T.']]);
  assert.equal((await out.del(`/api/groups/${gid}/posts/${pid}`)).status, 403);
  const rid = b.posts[1].replies[0].id;
  assert.equal((await mem.del(`/api/groups/${gid}/posts/${pid}/replies/${rid}`)).status, 403, "can't delete others' replies");
  assert.equal((await lead.del(`/api/groups/${gid}/posts/${pid}`)).status, 200, 'leaders can delete any post');

  // polls
  assert.equal((await mem.post(`/api/groups/${gid}/polls`, { question: 'Pizza?', options: ['Yes', 'No'] })).status, 403);
  for (const bad of [{ question: '', options: ['a', 'b'] }, { question: 'q', options: ['a'] }, { question: 'q', options: ['a', 'a'] }, { question: 'q', options: Array(9).fill(0).map((_, i) => `o${i}`) }]) {
    assert.equal((await lead.post(`/api/groups/${gid}/polls`, bad)).status, 400, JSON.stringify(bad));
  }
  b = (await lead.post(`/api/groups/${gid}/polls`, { question: 'Meeting day?', options: ['Monday', 'Wednesday', 'Friday'] })).data;
  const poll = b.polls[0].id;
  assert.equal((await mem.post(`/api/groups/${gid}/polls/${poll}/vote`, { choice: 3 })).status, 400);
  await mem.post(`/api/groups/${gid}/polls/${poll}/vote`, { choice: 0 });
  await mem.post(`/api/groups/${gid}/polls/${poll}/vote`, { choice: 1 }); // changed their mind
  b = (await lead.post(`/api/groups/${gid}/polls/${poll}/vote`, { choice: 1 })).data;
  assert.deepEqual([b.polls[0].counts, b.polls[0].myVote], [[0, 2, 0], 1]);
  await lead.put(`/api/groups/${gid}/polls/${poll}`, { closed: true });
  assert.equal((await mem.post(`/api/groups/${gid}/polls/${poll}/vote`, { choice: 2 })).status, 400, 'closed');
  assert.equal((await boss.get(`/api/groups/${gid}/board`)).status, 200, 'admins can see every board');

  // leaving takes nothing with it, but deleting your account removes your posts and votes
  await mem.post(`/api/groups/${gid}/posts`, { text: 'bye' });
  await mem.del('/api/me');
  b = (await lead.get(`/api/groups/${gid}/board`)).data;
  assert.ok(!b.posts.some((p) => p.text === 'bye'));
  assert.deepEqual(b.polls[0].counts, [0, 1, 0]);
});

// ---------------------------------------------------------------- study sessions

test('study sessions: planned for a class, seen by classmates, who say they are going', async () => {
  const ctx = await startApp({ mock });
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  const cy = await as(ctx, 3, { given_name: 'Cy' });
  await ann.put('/api/classes', { pink: { name: 'Chemistry', teacher: 'Lee' }, red: { name: 'English' } });
  await ben.put('/api/classes', { blue: { name: 'Chemistry', teacher: 'Lee' } });
  await cy.put('/api/classes', { pink: { name: 'Chemistry', teacher: 'Ng' } });

  for (const bad of [{ block: 'yellow', title: 'x', date: day(1) }, { block: 'pink', title: '', date: day(1) }, { block: 'pink', title: 'x', date: day(-1) },
    { block: 'pink', title: 'x', date: day(1), time: '3pm' }]) {
    assert.equal((await ann.post('/api/study', bad)).status, 400, JSON.stringify(bad));
  }
  const s = (await ann.post('/api/study', { block: 'pink', title: 'Test review', date: day(2), time: '15:15', place: 'Library' })).data;
  assert.deepEqual([s.going, s.me, s.block], [1, true, 'pink']);
  let seen = (await ben.get('/api/study')).data;
  assert.deepEqual(seen.map((x) => [x.title, x.block, x.people]), [['Test review', 'blue', ['Ann T.']]]);
  assert.deepEqual((await cy.get('/api/study')).data, [], 'different teacher, different class');
  assert.equal((await cy.post(`/api/study/${s.id}/going`, { on: true })).status, 404);
  seen = (await ben.post(`/api/study/${s.id}/going`, { on: true })).data;
  assert.deepEqual([seen.going, seen.me], [2, true]);
  assert.equal((await ben.del(`/api/study/${s.id}`)).status, 403);
  assert.equal((await ann.del(`/api/study/${s.id}`)).status, 200);
});

// ---------------------------------------------------------------- push

function decrypt(body, uaEcdh, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = uaEcdh.getPublicKey();
  const ikm = Buffer.from(crypto.hkdfSync('sha256', uaEcdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}
// A browser's push subscription, and a fake push service that decrypts what it receives.
function fakeDevice(host = 'web.push.apple.com') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    sub: { endpoint: `https://${host}/push/${crypto.randomBytes(8).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    read: (body) => decrypt(Buffer.from(body), ecdh, auth)
  };
}
function fakePushService(devices) {
  const svc = { got: [], status: 201 };
  svc.fetch = async (url, opts) => {
    const d = devices.find((x) => x.sub.endpoint === String(url));
    if (!d) return fetch(url, opts);
    assert.match(opts.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    assert.equal(opts.headers['Content-Encoding'], 'aes128gcm');
    svc.got.push({ device: d, msg: d.read(opts.body) });
    return new Response(null, { status: svc.status });
  };
  return svc;
}

test('push: VAPID header verifies with the public key', () => {
  const keys = webpush.generateVapidKeys();
  const auth = webpush.vapidAuth('https://web.push.apple.com/abc', keys, 'mailto:x@y.test');
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  assert.equal(k, keys.publicKey);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')).aud, 'https://web.push.apple.com');
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  for (const bad of ['http://web.push.apple.com/x', 'https://evil.test/x', 'https://web.push.apple.com.evil.test/x', 'https://fcm.googleapis.com:8443/x', 'nope']) {
    assert.equal(webpush.validEndpoint(bad), false, bad);
  }
  assert.ok(webpush.validEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
});

test('push: subscribe, choose kinds, test message, group announcements, gone devices dropped', async () => {
  const phone = fakeDevice();
  const laptop = fakeDevice('fcm.googleapis.com');
  const svc = fakePushService([phone, laptop]);
  const ctx = await startApp({ mock, fetchFn: svc.fetch });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });

  const info = (await ann.get('/api/push')).data;
  assert.match(info.publicKey, /^[\w-]{87}$/);
  assert.deepEqual(info.prefs, { classwork: true, events: true, groups: true });
  assert.equal((await ann.post('/api/push/test')).status, 400, 'no device yet');
  for (const bad of [{ endpoint: 'https://evil.test/x', keys: phone.sub.keys }, { endpoint: phone.sub.endpoint, keys: { p256dh: 'x', auth: 'y' } }, {}]) {
    assert.equal((await ann.post('/api/push/subscribe', bad)).status, 400);
  }
  assert.equal((await ann.post('/api/push/subscribe', phone.sub)).data.devices, 1);
  assert.equal((await ann.post('/api/push/subscribe', phone.sub)).data.devices, 1, 'same device once');
  assert.equal((await ben.post('/api/push/subscribe', laptop.sub)).data.devices, 1);

  assert.equal((await ann.post('/api/push/test')).status, 200);
  assert.deepEqual(svc.got.map((g) => g.msg.title), ['MHS Today']);

  // a group announcement reaches members (not the author), if they want group notifications
  const gid = (await ann.post('/api/groups', { name: 'Band', kind: 'club', joinPolicy: 'open' })).data.id;
  await boss.put(`/api/admin/groups/${gid}`, { approved: true });
  await ben.post(`/api/groups/${gid}/join`);
  svc.got = [];
  await ann.post(`/api/groups/${gid}/posts`, { text: 'No practice today', announcement: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(svc.got.map((g) => [g.device === laptop, g.msg.title, g.msg.body, g.msg.url]), [[true, 'Band: announcement', 'No practice today', `/group.html?id=${gid}`]]);
  assert.equal((await ben.put('/api/push/prefs', { groups: 'no' })).status, 400);
  await ben.put('/api/push/prefs', { groups: false });
  svc.got = [];
  await ann.post(`/api/groups/${gid}/posts`, { text: 'Practice tomorrow', announcement: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(svc.got.length, 0, 'Ben turned group notifications off');

  // the push service says the subscription is gone: it is removed
  svc.status = 410;
  await ann.post('/api/push/test');
  assert.equal((await ann.get('/api/push')).data.devices, 0);
  assert.ok(!JSON.stringify((await boss.get('/api/admin/backup')).data).includes('privateKey'), 'push keys are not in backups');
});

test('push: evening reminders from Google Tasks and an hour-before reminders, each sent once', async () => {
  const phone = fakeDevice();
  const svc = fakePushService([phone]);
  const ctx = await startApp({ mock, fetchFn: svc.fetch, env: { GOOGLE_TASKS: 'on' } });
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  await ann.put('/api/classes', { yellow: { name: 'Algebra II' } });
  await ann.post('/api/push/subscribe', phone.sub);
  assert.equal((await ann.connectTasks(mock)).headers.get('location'), '/classwork.html?tasks=connected');

  // pin the clock: 7:30 pm school time today, and 2:20 pm for the hour-before check
  const realNow = Date.now;
  const at = (date, hhmm) => { // school-time wall clock -> real ms (America/Chicago is UTC-5 or -6)
    for (const off of [5, 6]) {
      const ms = Date.parse(`${date}T${hhmm}:00Z`) + off * 3600e3;
      const s = cal.schoolNow('America/Chicago', new Date(ms));
      if (s.date === date && Math.round(s.minutes) === Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) return ms;
    }
    throw new Error('bad time');
  };
  try {
    const t = today();
    const due = (n) => `${cal.addDays(t, n)}T00:00:00.000Z`;
    mock.addTask('sub-1', { title: 'Unit 3 quiz', due: due(1) });
    mock.addTask('sub-1', { title: 'Essay', due: due(1) });
    mock.addTask('sub-1', { title: 'Done already', due: due(1), status: 'completed' });
    mock.addTask('sub-1', { title: 'Later', due: due(3) });
    await ann.post('/api/events', { title: 'Movie night', date: t, time: '15:00', visibility: 'private', invitees: [] });
    await ann.post('/api/study', { block: 'yellow', title: 'Quiz prep', date: t, time: '15:10' });

    Date.now = () => at(t, '16:00'); // too early for the evening reminder, events already started
    await ctx.app.runReminders();
    assert.equal(svc.got.length, 0);

    Date.now = () => at(t, '19:30');
    await ctx.app.runReminders();
    assert.deepEqual(svc.got.map((g) => [g.msg.title, g.msg.body, g.msg.url]), [['2 things due tomorrow', 'Essay\nUnit 3 quiz', '/classwork.html']]);
    await ctx.app.runReminders();
    assert.equal(svc.got.length, 1, 'only once');

    svc.got = [];
    Date.now = () => at(t, '14:20');
    await ctx.app.runReminders();
    assert.deepEqual(svc.got.map((g) => g.msg.title).sort(), ['Starting at 3:00 PM', 'Starting at 3:10 PM']);
    await ctx.app.runReminders();
    assert.equal(svc.got.length, 2, 'only once');

    // one task the next evening; then turning the kind off stops it
    svc.got = [];
    mock.addTask('sub-1', { title: 'Lab report', due: due(3) });
    Date.now = () => at(cal.addDays(t, 2), '19:00');
    await ctx.app.runReminders();
    assert.deepEqual(svc.got.map((g) => g.msg.title), ['2 things due tomorrow']);
    await ann.put('/api/push/prefs', { classwork: false });
    svc.got = [];
    Date.now = () => at(cal.addDays(t, 4), '19:00');
    mock.addTask('sub-1', { title: 'Poster', due: due(5) });
    await ctx.app.runReminders();
    assert.equal(svc.got.length, 0);
  } finally {
    Date.now = realNow;
  }
});

test('word filter: harmless look-alikes pass, disguised admin words are caught', () => {
  const f = createFilter(() => ['h8er', 'B00B']);
  for (const ok of ['Shiitake mushrooms', 'a niggling doubt', 'assessment', 'Scunthorpe', 'hater']) assert.equal(f.find(ok), null, ok);
  assert.equal(f.find('what a h8er'), 'hber');
  assert.equal(f.find('boob'), 'boob');
  assert.equal(f.find('b00b'), 'boob');
});
