'use strict';
// Google sign-in (OpenID Connect, authorization-code flow with PKCE) using only
// Node built-ins. The ID token's signature, issuer, audience, expiry and nonce
// are all checked here.
const crypto = require('node:crypto');

class AuthError extends Error {
  // code: 'failed' | 'unverified' (the page shows a friendly message for each)
  constructor(message, code = 'failed') { super(message); this.code = code; }
}

const sha256b64url = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const newPkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: sha256b64url(verifier) };
};

function createGoogle(cfg, { redirectUri, allowedDomains = [], fetchFn = fetch, now = Date.now } = {}) {
  let jwks = { keys: null, fetched: 0 };

  async function loadKey(kid) {
    let jwk = jwks.keys && jwks.keys.find((k) => k.kid === kid);
    const age = now() - jwks.fetched;
    // Refresh when we have nothing, the cache is over an hour old, or the key is
    // unknown (Google rotates keys) - but never more than once a minute.
    if ((!jwk || age > 3600e3) && (!jwks.keys || age > 60e3)) {
      try {
        const res = await fetchFn(cfg.jwksUrl, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!body || !Array.isArray(body.keys)) throw new Error('bad key set');
        jwks = { keys: body.keys, fetched: now() };
        jwk = jwks.keys.find((k) => k.kid === kid);
      } catch (e) {
        if (!jwk) throw new AuthError(`could not load Google signing keys: ${e.message}`);
        // otherwise keep using the cached key
      }
    }
    if (!jwk) throw new AuthError('ID token signed with an unknown key');
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  }

  function authUrl({ state, nonce, challenge }) {
    const u = new URL(cfg.authUrl);
    const params = {
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account'
    };
    if (allowedDomains.length === 1) params.hd = allowedDomains[0]; // only a hint; the domain is re-checked on the token
    u.search = new URLSearchParams(params).toString();
    return u.toString();
  }

  async function exchangeCode(code, verifier) {
    let res, body;
    try {
      res = await fetchFn(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier
        }),
        signal: AbortSignal.timeout(10000)
      });
      body = await res.json();
    } catch (e) {
      throw new AuthError(`token request failed: ${e.message}`);
    }
    if (!res.ok || !body || typeof body.id_token !== 'string') {
      throw new AuthError(`Google rejected the sign-in code (${body && body.error ? body.error : res.status})`);
    }
    return body.id_token;
  }

  async function verifyIdToken(idToken, nonce) {
    const parts = String(idToken).split('.');
    if (parts.length !== 3) throw new AuthError('malformed ID token');
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { throw new AuthError('malformed ID token'); }
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthError('unexpected ID token algorithm');
    if (!claims || typeof claims !== 'object') throw new AuthError('malformed ID token');

    const key = await loadKey(header.kid);
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!valid) throw new AuthError('bad ID token signature');

    const t = Math.floor(now() / 1000);
    if (!cfg.issuers.includes(claims.iss)) throw new AuthError('wrong token issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.clientId)) throw new AuthError('token was issued for a different app');
    if (typeof claims.exp !== 'number' || claims.exp < t - 60) throw new AuthError('ID token expired');
    if (typeof claims.iat === 'number' && claims.iat > t + 300) throw new AuthError('ID token issued in the future');
    if (typeof claims.nonce !== 'string' || claims.nonce.length !== String(nonce).length ||
        !crypto.timingSafeEqual(Buffer.from(claims.nonce), Buffer.from(String(nonce)))) throw new AuthError('nonce mismatch');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new AuthError('token has no subject');
    if (typeof claims.email !== 'string' || !claims.email || claims.email.length > 254) throw new AuthError('token has no email');
    if (claims.email_verified !== true && claims.email_verified !== 'true') throw new AuthError('Google says this email is not verified', 'unverified');
    return claims;
  }

  // Empty allow-list = any Google account. Otherwise the Workspace domain (`hd`)
  // on the verified token must be listed - the email suffix alone is not trusted.
  function domainAllowed(claims) {
    if (!allowedDomains.length) return true;
    return typeof claims.hd === 'string' && allowedDomains.includes(claims.hd.toLowerCase());
  }

  return { authUrl, exchangeCode, verifyIdToken, domainAllowed };
}

module.exports = { createGoogle, AuthError, newPkce };
