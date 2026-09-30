# MHS Hub

Site for Mukwonago High School: today's bell schedule, your classes, a shared events board, and friends who can see what class you're in. A small zero-dependency Node server (`server.js`) serves the pages in `public/` and a JSON API. All data is stored in one file, `$DATA_DIR/db.json`.

## Pages (`public/`)

- `index.html` — Dashboard: schedule, current period, upcoming events, friends
- `schedule.html` — Your classes per hour, per rotation day (A/B/C/D)
- `events.html` — Shared events board (anyone can read; sign in to add)
- `friends.html` — Add friends (mutual), see what class they're in now
- `tools.html` — Tools list
- `login.html` — Sign in / create account (username + password)

## Run locally

Needs Node 22+. Run `node server.js` and open http://localhost:8080. Data goes to `./data/db.json` (override with `DATA_DIR`).

## Deploy with WebManager

This repo is a WebManager **app** (`Dockerfile` + `webmanager.json`). It needs [app hosting](https://github.com/coolguy1333/WebManager/blob/main/docs/APP_HOSTING.md) turned on.

1. In WebManager, **Sources → add** this repository, then choose **Deploy as an app**.
2. Set the variables on the app's **Variables** page (both optional):
   - `ADMIN_USERS` — usernames that can set today's schedule type/day letter and delete any event. If empty, the first account created is the admin.
   - `ALLOW_REGISTRATION` — `true` (default) or `false`.
3. Create your account on the new site first so you're the admin.

### Backup and restore

Everything lives in `/data/db.json` inside the container. Per WebManager's [backup and restore](https://github.com/coolguy1333/WebManager#backup-and-restore):

- WebManager backs up `/data` automatically before each restart/update (last 3 kept in `/var/lib/webmanager/app-backups/<id>/`), and the normal server backup (`tar` of `/var/lib/webmanager`) includes those copies.
- For a current copy of the live data: `sudo docker cp webmanager-app-<id>:/data - > app-<id>-data.tar`
- To restore, follow *Restoring an app's data* in [APP_HOSTING.md § Operations](https://github.com/coolguy1333/WebManager/blob/main/docs/APP_HOSTING.md#7-operations).

The database holds password hashes (scrypt) and login sessions — store backups securely.

## Bell schedule data

Times in `public/js/bellSchedule.js` come from MHS's official "Daily Rotating Schedule" doc. There's no public feed for which day (A/B/C/D) or schedule type applies on a date, so an admin sets it on the dashboard for everyone.

More detail: [`DOCS.md`](./DOCS.md).
