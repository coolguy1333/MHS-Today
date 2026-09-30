# MHS Hub — Documentation

## Structure

```
server.js          HTTP server: static files from public/ + JSON API (no dependencies)
public/            Pages, css/, js/ (app.js = API client, bellSchedule.js = period times)
Dockerfile         Image for WebManager app hosting (runs as user `node`, data in /data)
webmanager.json    Health check (/api/health) and dashboard variables
```

## Data (`$DATA_DIR/db.json`)

Written atomically (temp file + rename). Shape:

| Key | Contents |
|---|---|
| `users` | `{ username: { salt, hash, classes: { "A_1": {name, teacher, room, color} } } }` |
| `sessions` | `{ token: { username, expires } }` — 30-day cookie sessions |
| `events` | `[ { id, title, date, time, description, by } ]` — shared |
| `today` | `{ scheduleType, dayLetter }` — shared, admin-set |
| `friends` | `{ username: [names they've added] }` — friends = both directions |

## API

State-changing requests need `X-Requested-With: mhs` (CSRF guard), and `Content-Type: application/json` when they have a body.

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | — | Health check |
| `GET /api/me` | — | Current user (or `null`) |
| `POST /api/register`, `/api/login`, `/api/logout` | — | Accounts |
| `GET/PUT /api/today` | PUT: admin | Schedule type + day letter |
| `GET/PUT /api/classes` | user | Your classes |
| `GET/POST /api/events`, `DELETE /api/events/:id` | write: user (delete: owner/admin) | Events |
| `GET /api/friends`, `POST/DELETE /api/friends/:username` | user | Request/accept/remove |

## Environment variables

`PORT` (8080), `HOST`, `DATA_DIR` (`./data`), `ADMIN_USERS`, `ALLOW_REGISTRATION`. WebManager sets the first three.

## Adding a tool

Add an entry to the `TOOLS` array in `public/tools.html`. Leave `url` empty to show "Coming soon".

## Limitations

- Accounts are username + password only (no email, so no password reset; an admin must edit `db.json`).
- Login throttling is in-memory (10 failures per IP per 15 min, resets on restart).
- Single JSON file: fine for a school-sized user base, not for heavy load.
