'use strict';
// Encrypts small secrets (Google Tasks refresh tokens) before they go into db.json. The key lives in
// its own file, $DATA_DIR/secret.key (0600), so a copy of db.json or a downloaded backup alone
// can't be used to read anyone's Google Tasks. If the key file is lost, people reconnect.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function openSecretBox(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  let key;
  try {
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!key || key.length !== 32) {
    key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
  }
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`;
    },
    // -> the text, or null if it can't be opened (wrong key, tampered, not ours)
    open(sealed) {
      try {
        const m = /^v1\.([A-Za-z0-9_-]+)$/.exec(String(sealed));
        const raw = Buffer.from(m[1], 'base64url');
        const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
      } catch { return null; }
    }
  };
}

module.exports = { openSecretBox };
