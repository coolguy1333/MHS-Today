# MHS Hub (static site, no accounts/backend — for now)

A plain HTML/CSS/JS site for Mukwonago High School: today's bell schedule, your classes, events, and a tools page. No server, no database, no login — everything is saved in your own browser's `localStorage`.

## Pages

- `index.html` — Dashboard: today's schedule type/day, current period highlighted, upcoming events
- `schedule.html` — Set your classes per hour, per rotation day (A/B/C/D)
- `events.html` — Add/view events (saved locally; links to the official MASD calendar)
- `tools.html` — Tools list. **Class Cards** is being built as its own app elsewhere in this project — set its URL in `tools.html` (`TOOLS` array) once it's deployed
- `friends.html` — Placeholder explaining that friends/sharing need real accounts (that version exists — see note below)

## Running it

No build step. Either:
- Open `index.html` directly in a browser, or
- Serve the folder with any static server, e.g. `npx serve .` or `python3 -m http.server`

## Bell schedule data

Times in `js/bellSchedule.js` come from MHS's official "Daily Rotating Schedule" doc (linked from mhs.masd.k12.wi.us as "Bell Schedule"). There's no public feed for which day (A/B/C/D) or schedule type (Daily/Advisory/Early Release) applies on a given date, so you pick it yourself on the dashboard.

## Note

A fuller version with real Google sign-in, a shared database, and friends who can see each other's current class was built first — it's a small Node/Express + SQLite app. This static version strips all of that out per request ("just the site, no oauth or database for now"). Bring the server version back when you're ready to self-host accounts.

## More documentation

See [`DOCS.md`](./DOCS.md) for project structure, how the `localStorage` data model works, the bell schedule format, how to add a new tool, and known limitations.
