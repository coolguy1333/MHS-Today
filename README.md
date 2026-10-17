# MHS Hub

Schedule, events and friends for Mukwonago High School students.

- **Today**: the day letter (A–D) and bell schedule, worked out automatically from a school calendar, with a live "Hour 3 · 23 min left" countdown ("B Lunch · 12 min left" at lunch), your own classes, and what's next.
- **My Schedule**: enter each class once, by color block (Yellow, Red, Pink, Green, Orange, Purple, Silver, Blue). The day letter decides which hour each block meets in, following the MHS Daily Schedule grid. Pick your A, B or C lunch on your Hour 4 classes (Green on Day A, Orange on Days B–D).
- **Classwork**: classmates post assignments, quizzes and tests to a class; only people in that class see them, and they show next to the class on Today. Three reports hide a post until an admin checks it. Classmates can also plan **study sessions** (for the class or one quiz/test) and say they're going.
- **Reminders and the app**: add MHS Hub to your phone's home screen (on iPhone: Safari → Share → Add to Home Screen) to use it like an app, offline included, and turn on notifications on the Account page: classwork due tomorrow, an hour before your events and study sessions, and group announcements.
- **Calendar sync**: a private link that puts your classwork, events, study sessions and no-school days into your iPhone or Google calendar.
- **Announcements and countdowns**: admins put a banner on every page (snow day, spirit week) and countdowns on Today (finals, winter break).
- **Word filter** on everything students type, plus words admins add.
- **Groups**: clubs, sports and student groups, each with its own page, links, members, events calendar, a members-only board (posts, replies, announcements) and polls. Anyone can start one; admins approve it before it's listed. Leaders accept members and post the group's events.
- **Lunch**: today's high school lunch menu, pulled from the district's My School Menus page, with your lunch time and which friends share it. A short version is on the Today page.
- **Events**: for everyone (posted by admins, verified people and leaders of approved groups), for a group's members, or private for friends you invite. Any event can have a sign-up list with a limit. Admins can remove anything.
- **Tools**: an admin-managed list; students can suggest tools for admins to add.
- **Links**: important links (event tickets, athletic schedules, Infinite Campus, counseling…), kept up to date by admins from the Admin page.
- **Friends**: add people by searching their name, or with a private code or invite link, or from **People you may know** (friends of friends and classmates). For each friend you choose what they see: classes + lunch, lunch only, or nothing. See what class they're in right now (or that they're at lunch), which classes you share, and whether you have the same lunch today. Friends only see your classes if you allow it.
- **Sign in with Google** only. No passwords are stored; you can limit sign-in to your school's Google Workspace domain.
- **Profiles**: display name, avatar (an emoji or initials on a color), pronouns, grade, bio and up to 5 interests; friends can open your profile card. Admins can edit or reset anyone's profile and lock it against changes.
- **Admin page**: set the day letter and breaks, see setup problems, manage people (make admins, verify, edit, lock, remove), edit the links, download or restore a backup.

It is a small Node app with no dependencies (`server.js`, `src/`, pages in `public/`). All data is one file, `db.json`.

## Set it up on WebManager

This repo is a WebManager **app** (`Dockerfile` + `webmanager.json`), so [app hosting](https://github.com/coolguy1333/WebManager/blob/main/docs/APP_HOSTING.md) must be turned on.

1. **Deploy**: in WebManager, *Sources → add* this repository, choose **Deploy as an app**, and pick the address (for example `https://mhs.example.org`). It will ask for settings before it starts.
2. **Create Google credentials** ([Google Cloud Console](https://console.cloud.google.com/) → *APIs & Services → Credentials → Create credentials → OAuth client ID → Web application*):
   - *Authorized redirect URI*: `https://YOUR-ADDRESS/auth/google/callback` (exactly; the Admin page shows it too).
   - If asked for a consent screen: choose **Internal** when your school's Google Workspace owns the project (only school accounts can sign in); otherwise **External** and publish it. The app only asks for `openid email profile`, which needs no Google review.
3. **Fill in the app's Variables** in WebManager, then save (saving starts the app):

   | Variable | Required | Meaning |
   |---|---|---|
   | `GOOGLE_CLIENT_ID` | yes | From step 2. |
   | `GOOGLE_CLIENT_SECRET` | yes | From step 2 (stored encrypted by WebManager). |
   | `ADMIN_EMAILS` | yes | Comma-separated Google emails of the owners: they are always admins. Owners and other admins can make more admins on the Admin page. |
   | `ALLOWED_DOMAINS` | no | Comma-separated Google Workspace domains allowed to sign in, e.g. `masd.k12.wi.us`. Empty = any Google account. Personal Gmail accounts can't pass a domain filter. |
   | `MENU_DISTRICT`, `MENU_ID` | no | The lunch menu on My School Menus (both numbers are in the menu page's address). Defaults: `2534` (Mukwonago Area School District) and `133305` (Mukwonago High School Lunch Menu). `MENU_ID=off` hides the menu. |
| `EVENT_POSTING` | no | `verified` (default: admins and people an admin verifies on the Admin page), `everyone`, or `admins`. |

4. **First sign-in**: open the site, sign in with an admin email, open **Admin**, and set the day letter ("this date is Day B"), the weekday pattern if some weekdays are always Advisory/Early Release, and your no-school dates. The day letter then advances by itself on every school day. The **Setup check** at the top of the Admin page points out anything missing.

Sign-in works on the app's main address (the one you chose in step 1), not on extra domain aliases.

Notifications need the site on **https** (iPhones also need it added to the home screen). The keys that sign notifications are made on first start and kept in `db.json`; they are not in downloaded backups, so after restoring onto a new server people turn notifications on again.

## Backup and restore

Everything is in `/data/db.json` inside the app's volume (people's first name and last initial, Google email, classes, friends, events, the calendar). Login sessions are stored hashed and are never put in snapshots or downloads. Keep backups private.

| What | How |
|---|---|
| Automatic daily snapshot | The app writes `/data/backups/db-YYYY-MM-DD.json` every day and keeps 7. |
| WebManager's own copy | WebManager backs up `/data` before each restart or update (last 3, in `/var/lib/webmanager/app-backups/<id>/`). The normal server backup (`tar` of `/var/lib/webmanager`) includes those, but **not** the live volume. |
| A current copy | Admin page → **Download backup**, or on the server: `sudo docker cp webmanager-app-<id>:/data - > app-<id>-data.tar` |
| Restore in the browser | Admin page → choose a downloaded file, type `RESTORE`. Everything is validated first, and a safety copy of the current data is saved as `/data/backups/before-restore-…json`. |
| Restore on the server | Follow *Restoring an app's data* in [APP_HOSTING.md § Operations](https://github.com/coolguy1333/WebManager/blob/main/docs/APP_HOSTING.md#7-operations). To go back to one of the app's own snapshots instead:<br>`sudo docker stop webmanager-app-<id>`<br>`sudo docker run --rm -v webmanager-app-<id>-data:/data busybox sh -c 'cp /data/backups/db-YYYY-MM-DD.json /data/db.json && chown 1000:1000 /data/db.json && chmod 600 /data/db.json'`<br>`sudo docker start webmanager-app-<id>` |

If `db.json` is ever damaged the app refuses to start (rather than overwrite it) and says so in its log.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Google shows `redirect_uri_mismatch` | The redirect URI in the Google client must equal `YOUR-ADDRESS/auth/google/callback` exactly (Admin → Setup check shows it). |
| "That Google account can't be used here" | It isn't in `ALLOWED_DOMAINS`. The app log says which domain Google reported (`Sign-in blocked: …`). |
| "Sign-in has not been set up yet" | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are empty. |
| No Admin link after signing in | The Google email isn't in `ADMIN_EMAILS` (must match exactly, case doesn't matter). |
| Wrong day letter | Admin → Day letter: pick a date and its letter. Add any missed holidays under *No school*. |
| Friends can't see my classes | They must have accepted your request, and **Account → Let friends see my classes** must be on. |

## Run it locally

Needs Node 22+. Register `http://localhost:8080/auth/google/callback` as a redirect URI in your Google client, then:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... ADMIN_EMAILS=you@example.com node server.js
```

Data goes to `./data/` (set `DATA_DIR` to change). `SCHOOL_TZ` (default `America/Chicago`) is the school's time zone; it is only configurable outside WebManager.

## Tests

`npm test` runs the unit and integration tests (no dependencies, no network, Google is mocked). More detail on how the app works is in [`DOCS.md`](./DOCS.md).
