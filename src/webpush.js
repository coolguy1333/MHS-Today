'use strict';
// Web Push without dependencies: VAPID (RFC 8292) to identify this server to the push service,
// and aes128gcm message encryption (RFC 8291) so only the subscribed browser can read a message.
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// A new P-256 key pair: { publicKey (65-byte uncompressed point, base64url), privateKey (PEM) }.
function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' })
  };
}

// Authorization header value for a push endpoint.
function vapidAuth(endpoint, keys, subject, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const data = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${keys.publicKey}`;
}

// Encrypts `payload` (string) for a subscription's keys { p256dh, auth } (both base64url).
function encrypt(payload, sub, { salt = crypto.randomBytes(16), ecdh } = {}) {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys');
  const local = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Sends one message. Resolves to the HTTP status (201 = accepted; 404/410 = subscription is gone).
async function send(sub, payload, { keys, subject, fetchFn = fetch, ttl = 86400 }) {
  const res = await fetchFn(sub.endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: vapidAuth(sub.endpoint, keys, subject), 'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: 'normal'
    },
    body: encrypt(JSON.stringify(payload), sub)
  });
  return res.status;
}

// Only the browsers' real push services, so a subscription can't point the server elsewhere.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
function validEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === 'https:' && !u.port && PUSH_HOSTS.test(u.hostname) && endpoint.length <= 1000;
}

module.exports = { generateVapidKeys, vapidAuth, encrypt, send, validEndpoint };
