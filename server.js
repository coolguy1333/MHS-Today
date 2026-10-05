'use strict';
const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');

let config;
let app;
try {
  config = loadConfig();
  app = createApp(config);
} catch (e) {
  console.error(`Cannot start: ${e.message}`);
  process.exit(1);
}

app.listen().then((port) => {
  console.log(`MHS Hub listening on ${config.host}:${port} (public address ${config.publicUrl}, data in ${config.dataDir})`);
  if (!app.google) console.warn('WARNING: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set, so nobody can sign in yet.');
  if (!config.adminEmails.size) console.warn('WARNING: ADMIN_EMAILS is empty, so nobody can edit the school calendar or manage users.');
  if (!config.allowedDomains.length) console.warn('NOTE: ALLOWED_DOMAINS is empty, so any Google account can sign in.');
  if (!config.secure) console.warn('NOTE: PUBLIC_URL is not https, so cookies are not marked Secure.');
}).catch((e) => {
  console.error(`Cannot listen on ${config.host}:${config.port}: ${e.message}`);
  process.exit(1);
});

function shutdown() {
  app.close().then(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
