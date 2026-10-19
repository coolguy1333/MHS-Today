'use strict';
// Profile photos. Someone uploads their own photo (the page shrinks it to a 256×256 JPEG first); it
// waits until an admin approves it in Admin → Review, and only then do other people see it. Photos
// are files in $DATA_DIR/photos (<random id>.jpg); the user keeps { approved, pending } ids.
// Photos are served at /photos/<id>.jpg to signed-in people only: an approved photo to anyone
// signed in, a pending one only to its owner and admins.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 150 * 1024;
const ID = /^[0-9a-f]{32}$/;

module.exports = function photos(app) {
  const { route, state, db, log, config, HttpError, bad, isAdmin, getUser, publicCard, limiter, isPlainObject } = app;
  const dir = path.join(config.dataDir, 'photos');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileOf = (id) => path.join(dir, `${id}.jpg`);
  const exists = (id) => ID.test(id || '') && fs.existsSync(fileOf(id));
  const drop = (id) => { if (ID.test(id || '')) fs.rm(fileOf(id), { force: true }, () => {}); };
  const photoOf = (u) => (isPlainObject(u.photo) ? u.photo : (u.photo = { approved: null, pending: null }));

  // Removes someone's photos (approved and waiting).
  function clear(u) {
    const p = photoOf(u);
    drop(p.approved); drop(p.pending);
    u.photo = { approved: null, pending: null };
  }

  route('POST', '/api/me/photo', { auth: 'user', maxBody: 300 * 1024, auditBody: false }, ({ user, body }) => {
    if (user.profileLocked) throw new HttpError(403, 'An admin locked your profile');
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(typeof body.image === 'string' ? body.image : '');
    const bytes = m ? Buffer.from(m[1], 'base64') : null;
    if (!bytes || bytes.length < 200 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw bad('That isn\'t a photo we can use. Try a JPG or PNG.');
    if (bytes.length > MAX_BYTES) throw bad('That photo is too big');
    if (!isAdmin(user) && !limiter.hit(`photo:${user.id}`, 5, 86400e3)) throw new HttpError(429, 'You can upload up to 5 photos a day');
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(fileOf(id), bytes, { mode: 0o600 });
    const p = photoOf(user);
    drop(p.pending);
    p.pending = id;
    p.at = Date.now();
    db.save();
    return { photo: urlOf(p.approved), pendingPhoto: urlOf(p.pending) };
  });
  route('DELETE', '/api/me/photo', { auth: 'user' }, ({ user }) => {
    clear(user);
    db.save();
    return { ok: true };
  });

  // ---- admins
  route('GET', '/api/admin/photos', { auth: 'admin' }, () => Object.values(state.users)
    .filter((u) => isPlainObject(u.photo) && u.photo.pending)
    .sort((a, b) => (a.photo.at || 0) - (b.photo.at || 0))
    .map((u) => ({ user: { ...publicCard(u), email: u.email }, pending: urlOf(u.photo.pending), current: urlOf(u.photo.approved), at: u.photo.at || null })));
  route('POST', '/api/admin/photos/:id/approve', { auth: 'admin' }, ({ user, params }) => {
    const u = getUser(params.id);
    if (!u || !isPlainObject(u.photo) || !u.photo.pending) throw new HttpError(404, 'No photo waiting');
    drop(u.photo.approved);
    u.photo.approved = u.photo.pending;
    u.photo.pending = null;
    log(`Photo for ${u.id} approved by admin ${user.id}`);
    db.save();
    return { ok: true };
  });
  route('POST', '/api/admin/photos/:id/reject', { auth: 'admin' }, ({ params }) => {
    const u = getUser(params.id);
    if (!u || !isPlainObject(u.photo) || !u.photo.pending) throw new HttpError(404, 'No photo waiting');
    drop(u.photo.pending);
    u.photo.pending = null;
    db.save();
    return { ok: true };
  });
  route('DELETE', '/api/admin/users/:id/photo', { auth: 'admin' }, ({ params }) => {
    const u = getUser(params.id);
    if (!u) throw new HttpError(404, 'No such user');
    clear(u);
    db.save();
    return { ok: true };
  });

  function urlOf(id) { return id ? `/photos/${id}.jpg` : null; }

  // GET /photos/<id>.jpg (outside /api: <img> tags send cookies but no custom headers)
  function serve(req, res, url, viewer) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const m = /^\/photos\/([0-9a-f]{32})\.jpg$/.exec(url.pathname);
    if (!m || !viewer) throw new HttpError(404, 'Not found');
    const id = m[1];
    const owner = Object.values(state.users).find((u) => isPlainObject(u.photo) && (u.photo.approved === id || u.photo.pending === id));
    const ok = owner && (owner.photo.approved === id || owner.id === viewer.id || isAdmin(viewer));
    if (!ok || !exists(id)) throw new HttpError(404, 'Not found');
    const body = fs.readFileSync(fileOf(id));
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length, 'Cache-Control': 'private, max-age=86400' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return {
    serve, clear, urlOf,
    status: () => ({ photosPending: Object.values(state.users).filter((u) => isPlainObject(u.photo) && u.photo.pending).length }),
    exportData: () => ({}), // ids travel with the users (see exportData in src/app.js); files are in /data/photos
    importData(data, users) {
      for (const u of Object.values(users)) {
        const p = isPlainObject(u.photo) ? u.photo : {};
        u.photo = { approved: exists(p.approved) ? p.approved : null, pending: exists(p.pending) ? p.pending : null, at: Number(p.at) || null };
      }
      return {};
    },
    // files nobody points to any more (a reset profile, a restore) are removed
    maintain() {
      const used = new Set(Object.values(state.users).flatMap((u) => (isPlainObject(u.photo) ? [u.photo.approved, u.photo.pending] : [])).filter(Boolean));
      for (const f of fs.readdirSync(dir)) {
        const id = f.replace(/\.jpg$/, '');
        if (ID.test(id) && !used.has(id)) drop(id);
      }
    },
    forgetUser(id, user) { if (user) clear(user); }
  };
};
