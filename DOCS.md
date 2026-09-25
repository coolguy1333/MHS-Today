# MHS Hub — Documentation

This is the static (no-login, no-server) version of the MHS Hub site: a schedule, events board, and tools page for Mukwonago High School students. Everything lives in the browser — there is no backend, database, or accounts in this version.

## Project structure

```
.
├── index.html          Dashboard: today's schedule + current period, upcoming events preview
├── schedule.html        Editor for your own classes, per hour, per rotation day (A/B/C/D)
├── events.html          Shared-looking but actually per-browser events board
├── tools.html           Tools list (currently just a link out to Class Cards)
├── friends.html         Placeholder explaining why friends/sharing isn't available yet
├── css/
│   └── style.css        All page styling (single shared stylesheet)
├── js/
│   ├── app.js            localStorage helpers + shared nav renderer
│   └── bellSchedule.js   The MHS bell schedule data + "what period is it right now" logic
├── README.md            Quick-start / running instructions
└── DOCS.md              This file
```

There is no build step and no dependencies. Any static file server (or just opening `index.html` in a browser) works.

## How data is stored

Everything is saved in the browser's `localStorage`, under three keys (see `js/app.js`):

| Key | Shape | Used for |
|---|---|---|
| `mhs_classes` | `{ "<dayLetter>_<hour>": { name, teacher, room, color } }` | Your class schedule, set on `schedule.html` |
| `mhs_today` | `{ scheduleType, dayLetter }` | Which bell schedule (Daily/Advisory/Early Release) and which rotation day is "today" — set from the dashboard |
| `mhs_events` | `[ { id, title, date, time, description } ]` | The events board |

Because this is `localStorage`, **each browser/device has its own separate copy** — nothing syncs between people or devices. That's the main limitation of this version (see "Known limitations" below).

## Bell schedule data (`js/bellSchedule.js`)

The three schedule types (`daily`, `advisory`, `early_release`) and their period times come from MHS's official "Daily Rotating Schedule" document (linked from mhs.masd.k12.wi.us as "Bell Schedule" / "Class Schedule"). Each schedule is a list of periods:

```js
{ hour: 1, label: 'Hour 1', start: '07:30', end: '08:32' }
```

`getCurrentPeriod(scheduleKey, now)` compares the current time against a schedule's periods and returns one of:
- `{ status: 'before-school', next }`
- `{ status: 'in-class', period }`
- `{ status: 'passing', next }`
- `{ status: 'after-school' }`

There is no public feed for which rotation day (A/B/C/D) or which schedule type applies on a given calendar date, so the dashboard just lets you pick both yourself (stored in `mhs_today`). If MHS ever publishes a rotation calendar, that's the place to wire up an automatic lookup instead of the manual dropdowns in `index.html`.

## Adding a new tool (`tools.html`)

Tools are just entries in the `TOOLS` array inside `tools.html`:

```js
const TOOLS = [
  { name: 'Class Cards', description: '...', url: '' } // url: '' shows "Coming soon"
];
```

Add a new object to that array to add a tool card. Class Cards itself is being built as a separate app — once it's deployed, put its URL in that `url` field.

## Known limitations (this version)

- **No accounts** — nothing identifies "you" across devices or browsers.
- **No sharing** — `events.html` and `schedule.html` only affect the browser you're using; two people never see the same data.
- **Friends/sharing don't work** — `friends.html` is a placeholder explaining this.
- **"Today's schedule" is manual** — no calendar feed tells the site which day letter or schedule type applies.

## The fuller version (reference)

A version with real Google OAuth sign-in, a shared SQLite database, and friends who can see each other's current class was built first, as a small Node.js/Express app. It's not in this repo's history in this branch, but the shape was:

- `server.js` + `routes/*.js` — Express app and routes (`/`, `/schedule`, `/friends`, `/events`, `/tools`, `/auth/google*`)
- `db/init.js` — SQLite schema (`users`, `classes`, `friendships`, `events`, `site_settings`)
- `lib/passport.js` — Google OAuth strategy
- `lib/bellSchedule.js` — same bell schedule data as this version
- `views/*.ejs` — server-rendered pages

That version needs a place to actually run (a small VM/LXC works well, since it's a plain Node process + local SQLite file — no external services required beyond Google OAuth credentials). Bring it back when you're ready to self-host real accounts; the bell schedule data and general page layout can be reused as-is.
