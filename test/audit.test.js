'use strict';
// The audit log: what gets recorded, who can read it, paging through a big file, downloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openAudit } = require('../src/audit');
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

test('audit file: newest first, search, paging across chunk boundaries, survives reopening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  try {
    let a = openAudit(dir);
    for (let i = 0; i < 3000; i++) a.record(i % 100 === 0 ? 'special' : 'POST /api/x', { actor: { id: 'u', name: `Person ${i}`, email: 'p@x' }, detail: { i, pad: 'x'.repeat(i % 37) } });
    a.close();
    a = openAudit(dir); // appending to the same file after a restart
    a.record('after restart');
    const first = a.page({ limit: 100 });
    assert.equal(first.entries[0].action, 'after restart');
    assert.equal(first.entries[1].detail.i, 2999);
    assert.equal(first.entries.length, 100);
    // walk every page: each entry exactly once, newest to oldest
    const seen = [];
    for (let p = first; ; p = a.page({ before: p.next, limit: 100 })) {
      seen.push(...p.entries.filter((e) => e.detail).map((e) => e.detail.i));
      if (p.next === null) break;
    }
    assert.equal(seen.length, 3000);
    assert.deepEqual(seen, [...Array(3000).keys()].reverse());
    const found = a.page({ q: 'SPECIAL', limit: 100 });
    assert.deepEqual(found.entries.map((e) => e.detail.i), [2900, 2800, 2700, 2600, 2500, 2400, 2300, 2200, 2100, 2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200, 1100, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100, 0]);
    assert.equal(found.next, null);
    assert.equal(fs.statSync(a.file).mode & 0o077, 0, 'private to the app');
    a.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit: sign-ins, changes and refused admin attempts are recorded; owners read and download it', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const kid = await as(ctx, 1, { given_name: 'Kim' });
  const helper = await as(ctx, 2, { given_name: 'Hal' });
  await boss.put(`/api/admin/users/${(await helper.me()).id}`, { admin: true }); // an admin, but not an owner
  await kid.put('/api/me', { bio: 'I like robots' });
  await kid.post('/api/events', { title: 'Study group', date: new Date(Date.now() + 86400e3).toISOString().slice(0, 10), visibility: 'private', invitees: [] });
  await kid.put('/api/push/prefs', { groups: false }); // not worth recording
  assert.equal((await kid.put('/api/admin/notices', { blockedWords: [] })).status, 403);
  await boss.put('/api/admin/notices', { blockedWords: ['meanword'] });

  assert.equal((await kid.get('/api/admin/audit')).status, 403);
  assert.equal((await helper.get('/api/admin/audit')).status, 403, 'admins who are not owners cannot read it');
  const log = (await boss.get('/api/admin/audit')).data;
  const actions = log.entries.map((e) => `${e.action} by ${e.actor ? e.actor.name : '-'}`);
  assert.equal(actions[0], 'PUT /api/admin/notices by Ada T.', 'newest first');
  assert.ok(actions.includes('refused (not an admin) by Kim T.'));
  assert.ok(actions.includes('PUT /api/me by Kim T.'));
  assert.ok(actions.includes('POST /api/events by Kim T.'));
  assert.ok(actions.includes('sign-in (new account) by Kim T.'));
  assert.ok(!actions.some((a) => a.includes('/api/push')), 'push settings are not recorded');
  const notices = log.entries[0];
  assert.deepEqual(notices.detail, { blockedWords: ['meanword'] });
  assert.equal(notices.actor.email, 'admin@school.test');
  assert.equal(notices.ip, '127.0.0.1');
  assert.deepEqual((await boss.get('/api/admin/audit?q=robots')).data.entries.map((e) => e.action), ['PUT /api/me']);

  // a restore is recorded without the (huge) file
  const backup = (await boss.get('/api/admin/backup')).data;
  await boss.post('/api/admin/restore', backup);
  const recent = (await boss.get('/api/admin/audit')).data.entries;
  assert.deepEqual(recent.slice(0, 2).map((e) => [e.action, e.detail]), [['POST /api/admin/restore', null], ['backup downloaded', null]]);

  // downloads: the whole log, oldest first, as a spreadsheet or JSON lines
  const csv = await boss.get('/api/admin/audit/download?format=csv');
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /filename="mhs-today-audit-\d{4}-\d{2}-\d{2}\.csv"/);
  const rows = csv.data.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(rows[0], 'time,action,by,by email,target,detail,ip');
  assert.match(rows[1], /sign-in \(new account\),Ada T\.,admin@school\.test/);
  assert.ok(rows.some((r) => r.includes('"{""blockedWords"":[""meanword""]}"')), 'JSON details are quoted for spreadsheets');
  const jsonl = await boss.get('/api/admin/audit/download');
  assert.match(jsonl.headers.get('content-type'), /ndjson/);
  const lines = (typeof jsonl.data === 'string' ? jsonl.data : JSON.stringify(jsonl.data)).trim().split('\n');
  assert.ok(lines.length >= 10);
  assert.equal((await helper.get('/api/admin/audit/download')).status, 403);
  assert.equal((await boss.get('/api/admin/audit')).data.entries[0].action, 'audit log downloaded');

  // it is never part of the in-app backup
  assert.ok(!JSON.stringify(backup).includes('sign-in'));
});
