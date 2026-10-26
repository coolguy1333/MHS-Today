# MHS Today

Schedule, events and friends for Mukwonago High School students.

MHS Today is an independent, self-hosted student project. It is not run by, part of, or endorsed by Mukwonago High School or the Mukwonago Area School District; the school can look into things on it if needed.

- **Today**: the day letter (A–D) and bell schedule, worked out automatically from a school calendar, with a live "Hour 3 · 23 min left" countdown ("B Lunch · 12 min left" at lunch), your own classes, what's next, and the next two weeks of day letters at a glance. New students get a short "Get set up" checklist (classes, a friend). **Simple mode** (a small button on Today) shows just a big clock, the block you're in and a smooth second-by-second countdown, optionally full screen, for a classroom screen or a Chromebook on the desk. Early Release and Late Arrival "classes" show as out of school.
- **My classes** (part of your profile): enter each class once, by color block (Yellow, Red, Pink, Green, Orange, Purple, Silver, Blue). The day letter decides which hour each block meets in, following the MHS Daily Schedule grid. Pick your A, B or C lunch on your Hour 4 classes (Green on Day A, Orange on Days B–D). Or paste your schedule copied from Infinite Campus and it fills everything in, lunches included (read on your device; nothing is sent until you save).
- **Assignments**: classmates add **tests, quizzes, assignments and projects** for a class; people in the same class (same name and teacher, whatever hour they have it) see them, on Assignments, next to the class on Today, in "Due soon", calendar feeds and the evening-before reminder. Classmates plan **study sessions** too. Each student's own **Google Tasks** is *coming soon* (built, switched off with `GOOGLE_TASKS` until the district allows the Tasks API).
- **Teachers**: at sign-up everyone picks student or teacher (accounts from before are students). Teachers get Today with their own classes (names only, no room or teacher), **Lesson plans** (a week view: for each day, the classes that meet and what each is doing; their students see it next to the class on Today and on their calendar), and Groups: student leaders invite a teacher to be their club's advisor, and the teacher accepts. Students can't find or friend teachers; everything else is for students.
- **Calendar**: one month with every event you can see, your clubs' events, tests and assignments for your classes, study sessions, day letters and days off (a list on phones), filterable, plus **Add to Google Calendar**.
- **Made for phones**: a tab bar at the bottom (Today, Schedule, Assignments, Friends, More), Save that stays in view while you edit your schedule, and no sideways scrolling.
- **Reminders and the app**: add MHS Today to your phone's home screen (on iPhone: Safari → Share → Add to Home Screen) to use it like an app, offline included, and turn on notifications in Profile → Notifications: tests and assignments due tomorrow, an hour before your events and study sessions, and group announcements.
- **Calendar sync**: private links (everything in one, or **School days**, **Classes & assignments** and **Events & clubs** as separate calendars, each with its own color in Google Calendar) that put every school day (7:00 until the last bell, 12:45 on early-release days, titled "Day B", "Day C · Early release"…), your events, study sessions and no-school days into your iPhone or Google calendar.
- **Announcements and countdowns**: admins put a banner on every page (snow day, spirit week) and countdowns on Today (finals, winter break).
- **Word filter** on everything students type, plus words admins add.
- **Groups**: clubs, sports and student groups, each with its own page, links, members, events calendar, a members-only board (posts, replies, announcements) and polls. Anyone can start one; admins approve it before it's listed. Leaders accept members and post the group's events; a staff **advisor** (made by an admin) can run it too, and the advisor's name shows on the page. Events can **repeat weekly** (meetings, practices), skipping days off.
- **Reporting**: anything students post (events, posts, replies, polls, study sessions, class events, profiles) has a Report button; three reports hide it until an admin keeps or removes it in Admin → Review.
- **Lunch**: today's high school lunch menu, pulled from the district's menu service, with your lunch time and which friends share it. A short version is on the Today page.
- **Events**: for everyone (posted by admins, verified people and leaders of approved groups), for a group's members, or private for friends you invite. Events have a start and end time, can last several days, say where they are (a room or an address), and have a kind (School, Sports, Clubs, Community, Holidays) you can filter by. Any event can have a sign-up list with a limit. Admins can remove anything.
- **Links**: important links, with a **Tools** section at the top (students can suggest tools), and the other links (event tickets, athletic schedules, Infinite Campus, counseling…), kept up to date by admins from the Admin page.
- **Friends**: add people by searching their name, or with a private code or invite link, or from **People you may know** (friends of friends and classmates). You pick what friends see by default (classes + lunch, lunch only, or nothing) and can change it for any one friend. In Profile → Privacy you also choose whether you see People you may know and whether you're suggested to friends of friends or classmates. See what class they're in right now (or that they're at lunch), which classes you share, and whether you have the same lunch today. Friends only see your classes if you allow it.
- **Sign in with Google** only. No passwords are stored; you can limit sign-in to your school's Google Workspace domain.
- **Profile** (in sections: Profile, My classes, Privacy, Notifications & calendar, Account): display name, avatar (an emoji or initials on a color) or **your own photo (drag and zoom to place it in the circle), shown once an admin approves it**, pronouns, grade, bio and up to 5 interests; friends can open your profile card. Admins can edit or reset anyone's profile and lock it against changes.
- **Graduation**: admins set graduation day; then seniors' accounts are archived (deleted 90 days later unless restored) and everyone else moves up a grade.
- **Feedback, About, Privacy & Terms**: students send bugs, ideas and questions from the Feedback page and see admins' answers there. Everyone reads and agrees to the Privacy & Terms on first sign-in (and again if they change), and can download their data or delete their account.
- **Admin page**, in tabs: Overview (only what needs fixing, what's waiting, and **visitors**: people, not bots, each day for 30 days, counted without cookies or anything that says who), Review (reports and photos to approve), Calendar (click a day in the month to make it advisory, early release, a custom schedule like MukReady, or a day off; custom schedules can be pasted from Infinite Campus), People (search and filter, students or teachers; click someone to verify, make admin or teacher, edit, lock or remove), Announcements, Blocked words, Links & tools, Feedback (reply in the app), Audit log (owners only) and Backup.
- **Audit log, kept forever**, so the school or district can look into something if they need to: every sign-in and change, who did it and when, in `/data/audit.log`. Owners can search and filter it (kind of action, who, dates) and download it as a spreadsheet.

It is a small Node app with no dependencies (`server.js`, `src/`, pages in `public/`). All data is one file, `db.json`.

## Set it up on WebManager

This repo is a WebManager **app** (`Dockerfile` + `webmanager.json`), so [app hosting](https://github.com/coolguy1333/WebManager/blob/main/docs/APP_HOSTING.md) must be turned on.

1. **Deploy**: in WebManager, *Sources → add* this repository, choose **Deploy as an app**, and pick the address (for example `https://mhs.example.org`). It will ask for settings before it starts.
2. **Create Google credentials** ([Google Cloud Console](https://console.cloud.google.com/) → *APIs & Services → Credentials → Create credentials → OAuth client ID → Web application*):
   - *Authorized redirect URI*: `https://YOUR-ADDRESS/auth/google/callback` (exactly; the Admin page shows it too).
   - If asked for a consent screen: choose **Internal** when your school's Google Workspace owns the project (only school accounts can sign in); otherwise **External** and publish it. Sign-in only asks for `openid email profile`, which needs no Google review.
   - *Later, for Assignments* (off for now, see `GOOGLE_TASKS`): turn on the **Google Tasks API** (*APIs & Services → Library → Google Tasks API → Enable*). Connecting asks for the `…/auth/tasks` scope, which Google calls *sensitive*: an **Internal** app needs nothing more; an **External** app shows an "unverified app" warning (and is limited to 100 people) until Google verifies it. Your Workspace admin may also need to allow the app under *Security → API controls*.
3. **Fill in the app's Variables** in WebManager, then save (saving starts the app):

   | Variable | Required | Meaning |
   |---|---|---|
   | `GOOGLE_CLIENT_ID` | yes | From step 2. |
   | `GOOGLE_CLIENT_SECRET` | yes | From step 2 (stored encrypted by WebManager). |
   | `ADMIN_EMAILS` | yes | Comma-separated Google emails of the owners: they are always admins. Owners and other admins can make more admins on the Admin page. |
   | `ALLOWED_DOMAINS` | no | Comma-separated Google Workspace domains allowed to sign in, e.g. `masd.k12.wi.us`. Empty = any Google account. Personal Gmail accounts can't pass a domain filter. |
   | `MENU_DISTRICT`, `MENU_SITE`, `MENU_ID` | no | The lunch menu, from its page's address: `menus.healthepro.com/organizations/<DISTRICT>/sites/<SITE>/menus/<ID>`. Defaults: `2534`, `15466` and `133305` ([Mukwonago High School Lunch Menu](https://menus.healthepro.com/organizations/2534/sites/15466/menus/133305)). The site number is only used for the "full menu" link. `MENU_ID=off` hides the menu. |
| `GOOGLE_TASKS` | no | `on` turns on Assignments from Google Tasks (needs the Google Tasks API, step 2). Off by default: the page says "Coming soon". |
| `EVENT_POSTING` | no | `verified` (default: admins and people an admin verifies on the Admin page), `everyone`, or `admins`. |

4. **First sign-in**: open the site, sign in with an admin email, open **Admin**, and set the day letter ("this date is Day B"), the weekday pattern if some weekdays are always Advisory/Early Release, and your no-school dates. The day letter then advances by itself on every school day. The Admin page's **Overview** points out anything missing (and only then).

Sign-in works on the app's main address (the one you chose in step 1), not on extra domain aliases.

The **audit log** (`/data/audit.log`) is never trimmed and is not in downloaded backups; WebManager's `/data` backups include it. Keep it as long as you might need it.

**Google Tasks** connections are kept encrypted in `db.json` with a key in `/data/secret.key` (made on first start). Neither is in downloaded backups; restoring a backup on the same server keeps everyone's connection, and on a new server people press *Connect Google Tasks* again. WebManager's own `/data` backups include both.

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
