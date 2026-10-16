'use strict';
// Reads settings from environment variables (WebManager sets PORT, HOST,
// DATA_DIR, PUBLIC_URL and TRUST_PROXY itself; the rest come from the app's
// Variables page, see webmanager.json).
const path = require('node:path');

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function loadConfig(env = process.env) {
  const port = Number(env.PORT) || 8080;
  const publicUrl = String(env.PUBLIC_URL || `http://localhost:${port}`).trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(publicUrl); } catch { throw new Error(`PUBLIC_URL is not a valid URL: ${publicUrl}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`PUBLIC_URL must start with http:// or https://: ${publicUrl}`);

  const tz = env.SCHOOL_TZ || 'America/Chicago';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new Error(`SCHOOL_TZ is not a valid time zone: ${tz}`); }

  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
    publicUrl,
    publicHost: url.host.toLowerCase(),
    secure: url.protocol === 'https:',
    // Behind WebManager's Nginx: believe X-Real-IP (Nginx overwrites it).
    trustProxy: env.TRUST_PROXY === 'true',
    tz,
    google: {
      clientId: String(env.GOOGLE_CLIENT_ID || '').trim(),
      clientSecret: String(env.GOOGLE_CLIENT_SECRET || '').trim(),
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['https://accounts.google.com', 'accounts.google.com']
    },
    adminEmails: new Set(list(env.ADMIN_EMAILS)),
    allowedDomains: list(env.ALLOWED_DOMAINS).map((d) => d.replace(/^@/, '')),
    // verified (default): admins and people an admin has verified; everyone: any signed-in student; admins: admins only.
    eventPosting: ['everyone', 'admins'].includes(env.EVENT_POSTING) ? env.EVENT_POSTING : 'verified',
    // Lunch menu on Health-e Pro / My School Menus (the ids are in the menu page's address).
    // Defaults: Mukwonago Area School District, Mukwonago High School Lunch Menu. MENU_ID=off turns it off.
    menu: {
      district: /^\d{1,9}$/.test(env.MENU_DISTRICT || '') ? env.MENU_DISTRICT : '2534',
      id: env.MENU_ID === 'off' ? '' : /^\d{1,9}$/.test(env.MENU_ID || '') ? env.MENU_ID : '133305'
    },
    sessionDays: 60,
    maxUsers: 5000,
    maxEvents: 3000
  };
}

module.exports = { loadConfig };
