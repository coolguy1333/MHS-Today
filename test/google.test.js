'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogle, AuthError } = require('../src/google');
const { startMockGoogle } = require('./mock-google');

async function setup(opts = {}) {
  const mock = await startMockGoogle();
  const cfg = {
    clientId: mock.clientId, clientSecret: mock.clientSecret, authUrl: `${mock.origin}/auth`,
    tokenUrl: `${mock.origin}/token`, jwksUrl: `${mock.origin}/certs`, issuers: [mock.origin]
  };
  const g = createGoogle(cfg, { redirectUri: 'https://app.test/auth/google/callback', allowedDomains: opts.allowedDomains || [] });
  return { mock, g };
}
const reject = async (p, re) => assert.rejects(p, (e) => e instanceof AuthError && (!re || re.test(e.message)));

test('accepts a valid token', async () => {
  const { mock, g } = await setup();
  const claims = await g.verifyIdToken(mock.signToken(mock.baseClaims('n1')), 'n1');
  assert.equal(claims.email, 'student@school.test');
  await mock.close();
});

test('rejects wrong audience, issuer, expiry, future iat and nonce', async () => {
  const { mock, g } = await setup();
  const ok = mock.baseClaims('n1');
  await reject(g.verifyIdToken(mock.signToken({ ...ok, aud: 'someone-else' }), 'n1'), /different app/);
  await reject(g.verifyIdToken(mock.signToken({ ...ok, iss: 'https://evil.test' }), 'n1'), /issuer/);
  await reject(g.verifyIdToken(mock.signToken({ ...ok, exp: Math.floor(Date.now() / 1000) - 600 }), 'n1'), /expired/);
  await reject(g.verifyIdToken(mock.signToken({ ...ok, iat: Math.floor(Date.now() / 1000) + 3600 }), 'n1'), /future/);
  await reject(g.verifyIdToken(mock.signToken(ok), 'other-nonce'), /nonce/);
  await reject(g.verifyIdToken(mock.signToken({ ...ok, nonce: undefined }), 'n1'), /nonce/);
  await mock.close();
});

test('rejects forged signatures and algorithm tricks', async () => {
  const { mock, g } = await setup();
  const ok = mock.baseClaims('n1');
  await reject(g.verifyIdToken(mock.signToken(ok, { key: mock.wrongKey }), 'n1'), /signature/);
  await reject(g.verifyIdToken(mock.signToken(ok, { header: { kid: 'nope' } }), 'n1'), /unknown key/);
  // alg:none
  const none = `${Buffer.from('{"alg":"none","kid":"test-key-1"}').toString('base64url')}.${Buffer.from(JSON.stringify(ok)).toString('base64url')}.`;
  await reject(g.verifyIdToken(none, 'n1'), /algorithm/);
  // HS256 signed with the public key as secret (classic confusion attack)
  await reject(g.verifyIdToken(mock.signToken(ok, { header: { alg: 'HS256' } }), 'n1'), /algorithm/);
  for (const junk of ['', 'a.b', 'a.b.c', 'x'.repeat(50)]) await reject(g.verifyIdToken(junk, 'n1'));
  // tampered payload keeps the old signature
  const [h, , s] = mock.signToken(ok).split('.');
  const evil = Buffer.from(JSON.stringify({ ...ok, email: 'admin@school.test' })).toString('base64url');
  await reject(g.verifyIdToken(`${h}.${evil}.${s}`, 'n1'), /signature/);
  await mock.close();
});

test('email must be present and verified; subject required', async () => {
  const { mock, g } = await setup();
  const ok = mock.baseClaims('n1');
  await assert.rejects(g.verifyIdToken(mock.signToken({ ...ok, email_verified: false }), 'n1'), (e) => e.code === 'unverified');
  await assert.rejects(g.verifyIdToken(mock.signToken({ ...ok, email_verified: undefined }), 'n1'), (e) => e.code === 'unverified');
  assert.ok(await g.verifyIdToken(mock.signToken({ ...ok, email_verified: 'true' }), 'n1'));
  await reject(g.verifyIdToken(mock.signToken({ ...ok, email: undefined }), 'n1'), /email/);
  await reject(g.verifyIdToken(mock.signToken({ ...ok, sub: undefined }), 'n1'), /subject/);
  await mock.close();
});

test('domain allow-list uses the verified hd claim, not the email suffix', async () => {
  const { mock, g } = await setup({ allowedDomains: ['school.test'] });
  assert.equal(g.domainAllowed({ hd: 'school.test', email: 'a@school.test' }), true);
  assert.equal(g.domainAllowed({ hd: 'SCHOOL.test', email: 'a@school.test' }), true);
  assert.equal(g.domainAllowed({ hd: 'other.test', email: 'a@school.test' }), false);
  assert.equal(g.domainAllowed({ email: 'a@school.test' }), false); // personal account with a school-looking address
  assert.equal(g.domainAllowed({ hd: ['school.test'], email: 'a@school.test' }), false);
  const open = createGoogle({ issuers: [] }, { redirectUri: 'x', allowedDomains: [] });
  assert.equal(open.domainAllowed({ email: 'anyone@gmail.com' }), true);
  await mock.close();
});

test('signing keys are cached and refreshed at most once a minute', async () => {
  let t = 1_000_000;
  const mock = await startMockGoogle();
  const cfg = { clientId: mock.clientId, clientSecret: 'x', authUrl: '', tokenUrl: '', jwksUrl: `${mock.origin}/certs`, issuers: [mock.origin] };
  const g = createGoogle(cfg, { redirectUri: 'x', now: () => t });
  const tok = () => mock.signToken(mock.baseClaims('n', Math.floor(t / 1000)));
  await g.verifyIdToken(tok(), 'n');
  await g.verifyIdToken(tok(), 'n');
  assert.equal(mock.jwksCalls, 1);
  // unknown key id right away: no refetch storm
  await reject(g.verifyIdToken(mock.signToken(mock.baseClaims('n', Math.floor(t / 1000)), { header: { kid: 'rotated' } }), 'n'));
  assert.equal(mock.jwksCalls, 1);
  t += 61_000;
  await reject(g.verifyIdToken(mock.signToken(mock.baseClaims('n', Math.floor(t / 1000)), { header: { kid: 'rotated' } }), 'n'));
  assert.equal(mock.jwksCalls, 2);
  await mock.close();
});

test('authorization URL carries PKCE, state, nonce and only hints a single domain', async () => {
  const { mock, g } = await setup({ allowedDomains: ['school.test'] });
  const u = new URL(g.authUrl({ state: 's', nonce: 'n', challenge: 'c' }));
  const q = u.searchParams;
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'openid email profile');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('redirect_uri'), 'https://app.test/auth/google/callback');
  assert.equal(q.get('state'), 's'); assert.equal(q.get('nonce'), 'n'); assert.equal(q.get('hd'), 'school.test');
  const two = createGoogle({ clientId: 'c', authUrl: 'https://x.test/a' }, { redirectUri: 'r', allowedDomains: ['a.test', 'b.test'] });
  assert.equal(new URL(two.authUrl({ state: 's', nonce: 'n', challenge: 'c' })).searchParams.get('hd'), null);
  await mock.close();
});

test('code exchange sends the secret and verifier, and surfaces Google errors', async () => {
  const { mock, g } = await setup();
  // Drive the mock's /auth to get a code for a known nonce/challenge.
  const crypto = require('node:crypto');
  const verifier = 'v'.repeat(43);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = await fetch(g.authUrl({ state: 's', nonce: 'nn', challenge }), { redirect: 'manual' });
  const code = new URL(a.headers.get('location')).searchParams.get('code');
  const idToken = await g.exchangeCode(code, verifier);
  assert.equal((await g.verifyIdToken(idToken, 'nn')).sub, 'sub-1');
  await reject(g.exchangeCode(code, verifier), /rejected/); // codes are single use
  await mock.close();
});
