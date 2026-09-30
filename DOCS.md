# MHS Hub: how it works

## Layout

```
server.js            starts the app; exits with a clear message on bad settings
src/config.js        environment variables -> settings
src/app.js           security headers, Google sign-in routes, JSON API, static files
src/google.js        Google OpenID Connect (code flow + PKCE, ID-token verification)
src/db.js            db.json: atomic writes, daily snapshots, old-format archive
src/util.js          text cleaning, cookies, rate limiter, friend codes
public/              the pages; js/calendar.js and js/bellSchedule.js are shared with the server
public/js/pages/     one script per page (no inline scripts anywhere)
test/                node:test suites, a mock Google, and helpers
Dockerfile, webmanager.json   what WebManager needs to run it as an app
```

## The school calendar

`public/js/calendar.js` is loaded by the browser **and** `require`d by the server, so both always agree. A calendar is plain data (saved from the Admin page):

```
anchorDate, anchorLetter   the first school day on/after anchorDate is this letter
noSchool      { 'YYYY-MM-DD': 'Fall break' }   weekends are implicit
types         { 'YYYY-MM-DD': 'advisory' | 'early_release' | 'daily' }   one-day overrides
weekdayTypes  { '3': 'advisory' }   repeating pattern, 1 = Monday
```

The letter advances one step per school day (a weekday not listed in `noSchool`). "Today" and the live period are computed in the school's time zone, using the server's clock so a wrong phone clock doesn't matter. Bell times are in `public/js/bellSchedule.js`.

## Data (`$DATA_DIR/db.json`)

Written atomically (temp file, fsync, rename), mode 0600. Shape: `users` (id → `{ sub, email, name, classes, friends: [ids], friendCode, shareSchedule }`), `sessions` (SHA-256 of the cookie token → user and expiry), `events`, `calendar`. A friendship exists when both people list each other. An older password-based `db.json` (first release) is archived to `backups/db.old-format-*.json` and the app starts empty.

## API

State-changing requests must send `X-Requested-With: mhs` (and `Content-Type: application/json` when there is a body).

| Route | Who | Purpose |
|---|---|---|
| `GET /auth/google`, `/auth/google/callback` | anyone | Sign-in |
| `GET /api/health` `/api/me` `/api/calendar` `/api/events` | anyone | Health, current user + settings, calendar, events (author names only for signed-in viewers) |
| `POST /api/logout` | anyone | End the session |
| `PUT /api/me`, `POST /api/me/friend-code`, `DELETE /api/me` | signed in | Name/privacy, new friend code, delete account |
| `GET/PUT /api/classes` | signed in | Own classes |
| `POST /api/events`, `DELETE /api/events/:id` | signed in (delete: owner or admin) | Events |
| `GET /api/friends`, `POST /api/friends/lookup`, `POST /api/friends/request`, `POST /api/friends/:id/accept`, `DELETE /api/friends/:id` | signed in | Friends |
| `GET /api/admin/status` `users`, `DELETE /api/admin/users/:id`, `PUT /api/admin/calendar`, `GET /api/admin/backup`, `POST /api/admin/restore` | admin | Admin |

## Security design

- **Sign-in**: authorization-code flow with PKCE, `state` and `nonce`. The pending-login cookie is signed and ties the callback to the browser that started it (no login CSRF). The ID token's RS256 signature (Google's published keys), issuer, audience, expiry and nonce are checked; the email must be verified. Accounts are keyed by Google's `sub`, not the email. `ALLOWED_DOMAINS` checks the token's Workspace `hd` claim, never the email suffix. Admins are the verified emails in `ADMIN_EMAILS`.
- **Sessions**: random 256-bit token in an `HttpOnly; SameSite=Lax` cookie (`Secure` and `__Host-` prefixed over https, so sibling subdomains can't plant cookies). Only the token's hash is stored. Sign-in rotates the session, sign-out deletes it on the server, 10 sessions per person, 60-day expiry.
- **Requests**: custom-header + same-host `Origin` + `Sec-Fetch-Site` checks on every write; no CORS. Strict CSP (`script-src 'self'`, `style-src 'self'`, no inline code), `frame-ancestors 'none'`, nosniff, same-origin referrer/resource policies, HSTS over https, `noindex`.
- **No XSS by construction**: pages build DOM with `h()` (text nodes); `innerHTML` is never used. Text from users is stripped of control, zero-width and bidi-override characters and length-limited on the server.
- **Abuse limits**: 120 writes/minute per person, 10 events/day per student, friend-code lookups and requests limited per hour, sign-in throttled per address (generous, because a school shares one address), caps on users, events and friends. Client address comes from `X-Real-IP` only when `TRUST_PROXY=true` (WebManager's Nginx overwrites it).
- **Data handling**: default display name is first name + last initial; emails are never sent to other students; friend codes can be regenerated; deleting an account removes the person, their events, sessions and friend links; nothing sensitive is logged.

## Adding a tool

Add an entry to `TOOLS` in `public/js/pages/tools.js`; an empty `url` shows "Coming soon".

## Limits

One JSON file in memory: comfortable for a school (a 3,000-student database with full schedules idles around 130 MB, hence the 512 MB container limit), not for huge sites. Restore files are limited to 12 MB and accounts to 5,000. Login throttling and rate limits are in memory and reset on restart.
