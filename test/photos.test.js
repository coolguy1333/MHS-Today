'use strict';
// Profile photos: uploaded, approved by an admin, and only then seen by anyone else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
// a tiny but real-looking JPEG: the right first bytes and some data
const jpeg = (fill = 1) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, fill), Buffer.from([0xff, 0xd9])]).toString('base64')}`;
async function befriend(a, b) {
  await a.post('/api/friends/request', { code: (await b.me()).friendCode });
  await b.post('/api/friends/request', { code: (await a.me()).friendCode });
}
const status = async (c, url) => (await c.raw('GET', url, { xhr: false })).status;

test('photos: waiting until an admin approves; private to signed-in people; removable', async () => {
  const ctx = await startApp({ mock });
  const boss = await owner(ctx);
  const ann = await as(ctx, 1, { given_name: 'Ann' });
  const ben = await as(ctx, 2, { given_name: 'Ben' });
  await befriend(ann, ben);

  for (const bad of [{}, { image: 'data:image/png;base64,iVBORw0KGgo=' }, { image: 'data:image/jpeg;base64,AAAA' },
    { image: `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200 * 1024)]).toString('base64')}` }]) {
    assert.equal((await ann.post('/api/me/photo', bad)).status, 400);
  }
  const up = (await ann.post('/api/me/photo', { image: jpeg() })).data;
  assert.equal(up.photo, null);
  assert.match(up.pendingPhoto, /^\/photos\/[0-9a-f]{32}\.jpg$/);
  // waiting: only Ann and admins can load it; friends still see the avatar
  assert.equal(await status(ann, up.pendingPhoto), 200);
  assert.equal(await status(boss, up.pendingPhoto), 200);
  assert.equal(await status(ben, up.pendingPhoto), 404);
  assert.equal((await ben.get('/api/friends')).data.friends[0].photo, null);

  const queue = (await boss.get('/api/admin/photos')).data;
  assert.deepEqual(queue.map((p) => [p.user.name, p.pending]), [['Ann T.', up.pendingPhoto]]);
  assert.equal((await boss.get('/api/admin/status')).data.photosPending, 1);
  assert.equal((await ben.post(`/api/admin/photos/${(await ann.me()).id}/approve`)).status, 403);
  await boss.post(`/api/admin/photos/${(await ann.me()).id}/approve`);
  const card = (await ben.get('/api/friends')).data.friends[0];
  assert.equal(card.photo, up.pendingPhoto, 'approved: friends see it');
  assert.equal(await status(ben, card.photo), 200);
  const res = await ben.raw('GET', card.photo, { xhr: false });
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control'), /^private/);
  assert.equal(await status(ctx.client(), card.photo), 404, 'never to people who are not signed in');

  // a new photo waits while the old one stays up; a rejected one is gone
  const second = (await ann.post('/api/me/photo', { image: jpeg(2) })).data;
  assert.deepEqual([second.photo, !!second.pendingPhoto], [card.photo, true]);
  await boss.post(`/api/admin/photos/${(await ann.me()).id}/reject`);
  assert.equal(await status(ann, second.pendingPhoto), 404);
  assert.equal((await ann.me()).photo, card.photo);

  // a reset profile drops the photo; so does deleting your own
  await boss.put(`/api/admin/users/${(await ann.me()).id}`, { reset: true });
  assert.equal((await ann.me()).photo, null);
  await ann.post('/api/me/photo', { image: jpeg(3) });
  await ann.del('/api/me/photo');
  assert.deepEqual([(await ann.me()).photo, (await ann.me()).pendingPhoto], [null, null]);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fs.readdirSync(path.join(ctx.dataDir, 'photos')), [], 'files are deleted');

  // a locked profile can't change its photo
  await boss.put(`/api/admin/users/${(await ben.me()).id}`, { profileLocked: true });
  assert.equal((await ben.post('/api/me/photo', { image: jpeg() })).status, 403);
});
