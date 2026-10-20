# MHS Today: how it works

## Layout

```
server.js            starts the app; exits with a clear message on bad settings
src/config.js        environment variables -> settings
src/app.js           security headers, Google sign-in routes, JSON API, static files
src/google.js        Google OpenID Connect (code flow + PKCE, ID-token verification), token refresh and revoke
src/secretbox.js     AES-256-GCM for secrets at rest (key in $DATA_DIR/secret.key)
src/audit.js         the audit log ($DATA_DIR/audit.log, JSON lines, kept forever; paging, search, CSV download)
src/feedback.js      in-app feedback: students send, admins reply
src/db.js            db.json: atomic writes, daily snapshots, old-format archive
src/util.js          text cleaning, cookies, rate limiter, friend codes
src/menu.js          lunch menu from Health-e Pro (My School Menus), cached per month
src/tasks.js         Assignments: connect Google Tasks, and the server-side Tasks API proxy (off unless GOOGLE_TASKS=on)
src/study.js         study sessions
src/groups.js        groups and events (visibility, invitations, sign-up lists)
src/tools.js         the Tools section on Links and students' tool suggestions
src/notices.js       announcement banners, countdowns, admin-added blocked words
src/wordfilter.js    the word filter (whole words, common disguises undone)
public/js/icimport.js  reads a schedule copied from Infinite Campus ("Period Yellow", "Teacher: Last, First", "Lunch: B …") into color blocks, in the browser
src/icalendar.js     private calendar feeds (/cal/<token>.ics)
src/push.js          notification settings, subscriptions and reminders (every 5 minutes)
src/webpush.js       Web Push without dependencies: VAPID (RFC 8292) and aes128gcm encryption (RFC 8291)
public/sw.js, public/manifest.webmanifest   installable app: offline copy and showing notifications
public/              the pages; js/calendar.js, js/bellSchedule.js and js/avatars.js are shared with the server
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

The letter advances one step per school day (a weekday not listed in `noSchool`). "Today" and the live period are computed in the school's time zone, using the server's clock so a wrong phone clock doesn't matter. Bell times, the color-block rotation and lunch times are in `public/js/bellSchedule.js`.

## Lunch menu

`src/menu.js` reads the public Health-e Pro API that myschoolmenus.com uses (`/api/organizations/<district>/menus/<menu>/year/<y>/month/<m>/date_overwrites`). Each month is fetched by the server, cached for an hour, and the last good copy is kept if the service is down, so pages never contact another site (the CSP stays `connect-src 'self'`). Counters ("Grab n Go ($3.85)") become sections; "Or" lines are kept as notes.

## Friends: search and sharing levels

Name search matches every typed word against the start of the person's Google first/last name or display name (accents and punctuation ignored), skips people who turned search off, and returns only display names and grades (120 searches an hour per person). `shareDefault` (`full`, `lunch` or `none`, set in Profile → Privacy) is what friends see unless `shareLevels` has their id: `full` = classes and lunch, `lunch` = only which lunch you have on each day letter (sent as `lunches: { A: 'B', ... }`), `none` = nothing. Picking the default for a friend removes their entry, so they follow the default again. The Profile → Privacy "Let friends see my schedule" switch overrides every level.

## Feature modules

`src/study.js`, `src/tasks.js`, `src/groups.js`, `src/tools.js` and the others each get a small toolkit from `createApp` (`route`, `state`, `db`, user helpers…), add their routes, and return `exportData`, `importData(data, users)`, `maintain()`, `forgetUser(id, user)` and `status()`, which backups, restores, the six-hourly cleanup, account deletion and the Admin status use.

**Assignments (Google Tasks)** are off ("coming soon") unless `GOOGLE_TASKS=on`: then `/api/tasks` answers `{ available: false, comingSoon: true }`, connecting redirects back, and no reminders are sent. When on, `/auth/google?connect=tasks` runs a second Google round trip for the signed-in person only, asking for `openid email https://www.googleapis.com/auth/tasks` with `access_type=offline` and `prompt=consent` (and `login_hint` = their email). The callback must come back in the same browser session, for the same Google `sub`, with the Tasks scope ticked and a refresh token; otherwise the token is revoked and the Assignments page says why (`?tasks=scope|account|offline|denied|signin|failed`). The refresh token is sealed with AES-256-GCM (`src/secretbox.js`) in `user.googleTasks`; access tokens live only in memory. Pages call `/api/tasks`; the server calls `https://tasks.googleapis.com/tasks/v1` (open tasks from up to 10 lists, soonest first), so the CSP stays same-origin. If Google says the grant is gone (`invalid_grant`), the connection is forgotten and the page offers to connect again. Disconnecting and deleting an account revoke the token at Google. Tokens are never exported; an in-app restore keeps connections for matching `sub`s.

**Study sessions** are stored with the class's name and teacher; you see one when one of your classes is the same class (same name, and the same teacher when both have one).

**Groups**: `{ id, name, kind: club|sport|group, description, links, joinPolicy: open|approval, approved, members: { userId: 'leader'|'member' }, requests: [ids] }`. Unapproved groups are visible only to their members and admins. A group always keeps a leader; if the last person leaves or is deleted, the group and its events go too.

**Events**: `visibility` is `public` (posting follows `EVENT_POSTING`, or the poster leads an approved group the event belongs to), `group` (members only; posted by its leaders) or `private` (the author and `invitees`, who must be their friends). `signup: { limit (0 = none), people }`; organizers (author, group leaders) and admins see names, everyone else the count.

## Reminders, calendar sync and the installable app

**Push**: each device that turns notifications on sends its subscription (endpoint + keys); endpoints must belong to a real browser push service (Apple, Google, Mozilla, Microsoft). Messages are encrypted for the device and signed with the server's VAPID key (`state.vapid`, made on first start, never exported). A 404/410 from the push service removes that device. Reminders run every five minutes: between 6 and 9 pm school time, one message per person listing what's due tomorrow: class events for their classes, plus their Google Tasks when that's on (the `classwork` preference); and about an hour before any timed event they made, signed up for or were invited to, or a study session they're going to. `state.sentReminders` makes each go out once. Group announcements notify members straight away. People choose the kinds in Profile → Notifications.

**Events** have `date`, `time`, `endDate` (null = same day; at most 31 days), `endTime` (needs `time`; after it on single-day events), `location` (a room or address) and `category` (`school`, `sports`, `clubs`, `community`, `holidays`; a group's events default to its kind: sports → sports, everything else → clubs). Multi-day events stay "upcoming" until their last day and are cleaned up 60 days after it.

**Audit log** (`src/audit.js`): every successful POST/PUT/DELETE through the API is appended to `$DATA_DIR/audit.log` as `{ at, action: "<METHOD> <route pattern>", actor: { id, name, email }, target: <route params>, detail: <request body, cut at 2000 characters>, ip }`, plus sign-ins (`sign-in`, `sign-in (new account)`, `sign-in refused (domain)`), refused admin attempts and backup/audit downloads. Routes opt out with `audit: false` (look-ups, push settings) or keep the body out with `auditBody: false` (a restore file, someone's Google Tasks). The file is never trimmed or rotated, is not in in-app backups, and is readable only by owners (`ADMIN_EMAILS`): newest first, 100 at a time, read backwards from the end so memory stays small, with a text search; or downloaded whole as CSV (formula-safe) or JSON lines.

**Reports** (`src/reports.js`): content kinds register `locate(ref, user)` (null if `user` can't see it), `remove(ref)` and `exists(ref)`; `POST /api/reports { kind, ref, reason, note }`. Reports on the same thing (open, not yet handled) collect in one entry; three different reporters set `hidden`, and lists then show it only to its author (marked hidden) and admins. Admins keep (unhide) or remove it (`profile` reports never hide; removing resets the profile). Kinds: `event`, `post`, `reply`, `poll` (`ref.group`), `study`, `classwork`, `profile`. Handled reports are kept a year; reports aren't in backups.

**Class events** (`src/classevents.js`): `{ block, name, teacher, kind: test|quiz|assignment|project, title, due, notes, by }`. Visible when your class in that block has the same name and the same teacher (by last name; both must have one). Removed two weeks after they're due.

**Repeating events**: `repeat: { days: [0-6], until, skipNoSchool }` (no `endDate`; up to a year). Lists sort by the next meeting (`next`), calendar feeds get one entry per meeting (`ev-<id>-<date>`), reminders go out per meeting, and the event is cleaned up two months after `until`.

**Photos** (`src/photos.js`): `POST /api/me/photo { image: data:image/jpeg;base64 }` (the page crops and shrinks it to 256×256; at most 150 KB, must start like a JPEG). Files are `$DATA_DIR/photos/<32 hex>.jpg`; `user.photo = { approved, pending }`. `GET /photos/<id>.jpg` serves an approved photo to anyone signed in and a pending one only to its owner and admins; never to signed-out visitors. Unused files are removed by the six-hourly cleanup.

**Advisors and graduation**: group roles are `member`, `leader` and `advisor` (leader powers; only admins set or unset it); groups also have an `advisor` name. `state.school.graduation` (set in Admin → People): on that day the six-hourly cleanup archives grade-12 non-admins (`user.archived = { at, deleteAfter: +90 days }`: no sign-in, hidden from search, suggestions and friends lists, sessions ended) and moves grades 9–11 up one, once per date; archived accounts are deleted after `deleteAfter`. Both are in the audit log.

**Privacy & Terms**: `TERMS_VERSION` in `src/app.js` (match the date on `public/terms.html`). Until someone agrees to the current version (`POST /api/me/agree`), every change except agreeing, signing out and deleting the account answers 403 with `mustAgree`, and pages send them to `terms.html?agree=1&next=…`. The agreement is kept in backups.

**Feedback**: `{ type: bug|idea|question|other, message, page, status: new|seen|done, replies: [{ by, text, at }], unread }`. A reply marks it unread for the sender (shown on Today and the Feedback page, and pushed as a notification); finished feedback is removed a year after it was last touched; deleting an account removes theirs.

**Calendar feed**: `/cal/<48 hex>.ics` (calendar apps can't sign in, so the token is the key; it can be replaced or turned off). Every school day from two weeks back to six months ahead is an event from 7:00 to that day's last bell (14:45, or 12:45 on early release), titled with the day letter (`Day B`, `Day C · Early release`, `Day D · Advisory day`), so admin changes to the calendar show up on the next sync. Timed items are converted from school time to UTC; lines are folded at 75 bytes.

**Installable**: `manifest.webmanifest` plus `sw.js`, which goes to the network first and falls back to its copy offline (pages, scripts, and a few API answers such as your classes and the calendar). Signing out deletes the copy.

**Word filter**: whole words only (so "assess" passes), with common disguises undone (`sh1t`, `$hit`, `f u c k`, `fuuuck`); a few words also catch any ending (`fucking`). It runs on what students type: profiles, events, study sessions, groups, posts, polls and tool ideas.

## Admins, profiles and suggestions

Owners are the `ADMIN_EMAILS`; they are always admins and can't be demoted or removed in the app (except an owner removing another owner's account). Any admin can promote someone (`adminGranted`) or demote another non-owner admin, but not themselves.

Profiles: avatars are an emoji from a fixed list (or initials) on one of eight colors (`public/js/avatars.js`, no uploads). Non-friends (search, suggestions, requests) see only the card: display name, grade, avatar. Friends also see pronouns, bio and interests.

People you may know: confirmed friends of your confirmed friends ("2 mutual friends") and people with the same class in the same block ("In one of your classes", which class is never said). Each person's `suggest` settings (Profile → Privacy) decide this: `show` (see suggestions at all), `viaFriends` and `viaClasses` (be suggested through mutual friends or classes; accounts from before these settings start with their name-search choice). Classes only count when that person shares their schedule, a suggested person can be sent a request even if they're out of name search, and anyone you already asked, who asked you, or whom you hid is left out ("Show them again" in Privacy clears the hidden list). Score = mutual × 3 + shared classes × 2, top 8.

## Color blocks and lunch

Classes match between people when the names match and the teachers' last names match (or one side has no teacher): `MHSBell.sameClass`, shared by the server and the pages. Classes are saved per color block, not per day: `classes = { yellow: { name, teacher, room }, green: { name, teacher, room, lunch: 'A' }, ... }`. `ROTATION[letter][hour - 1]` (from the MHS Daily Schedule grid) says which block meets in each hour, so each class is entered once. Lunch is inside Hour 4, so it is stored on the blocks that meet in Hour 4 (`LUNCH_BLOCKS`: Green on Day A, Orange on B–D); `lunchFor(classes, letter)` gives someone's lunch for a day, and `LUNCHES` has the A/B/C times for each schedule type. Schedules saved by the first release (keys like `A_1`) are converted to blocks when the server starts and when they are sent to `PUT /api/classes`.

## Data (`$DATA_DIR/db.json`)

Written atomically (temp file, fsync, rename), mode 0600. Shape: `users` (id → `{ sub, email, name, classes, friends: [ids], friendCode, shareSchedule, verified, givenName, familyName, searchable, shareLevels: { friendId: 'lunch' | 'none' }, grade, bio, profileLocked, pronouns, interests: [..5], avatar: { emoji, color }, adminGranted, hiddenSuggestions: [ids] }`, plus `links` (the Links page). `givenName`/`familyName` come from Google, are refreshed at each sign-in, and are only used for name search and shown to admins), `sessions` (SHA-256 of the cookie token → user and expiry), `events`, `calendar`. A friendship exists when both people list each other. An older password-based `db.json` (first release) is archived to `backups/db.old-format-*.json` and the app starts empty.

## API

State-changing requests must send `X-Requested-With: mhs` (and `Content-Type: application/json` when there is a body).

| Route | Who | Purpose |
|---|---|---|
| `GET /auth/google`, `/auth/google/callback` | anyone | Sign-in |
| `GET /api/health` `/api/me` `/api/calendar` `/api/events` | anyone | Health, current user + settings, calendar, events (author names only for signed-in viewers) |
| `POST /api/logout` | anyone | End the session |
| `PUT /api/me`, `POST /api/me/friend-code`, `DELETE /api/me` | signed in | Name/privacy, new friend code, delete account |
| `GET/PUT /api/classes` | signed in | Own classes |
| `GET /api/lunch?date=` | anyone | Lunch menu for a day (today by default, up to 60 days either way) |
| `GET /api/links`, `GET /api/tools` | anyone | The important links; the tools |
| `POST /api/me/agree` (`{ version }`), `GET /api/me/export` | signed in | Agree to the Privacy & Terms; download my data |
| `POST /api/feedback` (`{ type, message, page }`), `GET /api/feedback` | signed in | Send feedback; your feedback and the replies |
| `GET /api/admin/feedback`, `PUT /api/admin/feedback/:id` (`{ status }`), `POST /api/admin/feedback/:id/reply` (`{ text }`), `DELETE /api/admin/feedback/:id` | admin | The feedback inbox |
| `POST /api/reports` (`{ kind, ref, reason, note }`) | signed in | Report something someone else posted |
| `GET /api/admin/reports`, `POST /api/admin/reports/:id/keep` `remove` | admin | The review queue |
| `GET/POST /api/classwork` (`{ block, kind, title, due, notes }`), `DELETE /api/classwork/:id` | signed in (delete: author or admin) | Class events for your classes |
| `POST/DELETE /api/me/photo`, `GET /photos/<id>.jpg` | signed in | Your photo; photos |
| `GET /api/admin/photos`, `POST /api/admin/photos/:uid/approve` `reject`, `DELETE /api/admin/users/:id/photo` | admin | Photos to approve |
| `PUT /api/admin/school` (`{ graduation }`), `PUT /api/admin/users/:id` (`{ archived: false }`) | admin | Graduation day; restore an archived account |
| `GET /api/admin/audit?q=&before=`, `GET /api/admin/audit/download?format=csv` | owners | The audit log |
| `GET /auth/google?connect=tasks` | signed in | Connect Google Tasks (when `GOOGLE_TASKS=on`) |
| `GET/POST /api/tasks` (`{ title, due, notes, listId }`), `PUT /api/tasks/:list/:task` (`{ done }`), `DELETE /api/tasks/connection` | signed in (and connected) | Your Google Tasks: open tasks, add, check off, disconnect |
| `GET/POST /api/groups`, `GET/PUT/DELETE /api/groups/:id`, `POST /api/groups/:id/join` `leave`, `PUT /api/groups/:id/members/:uid` (`{ role: 'leader' \| 'member' \| null }`) | signed in (changes: leaders or admins) | Groups |
| `GET /api/events?group=`, `POST /api/events` (`{ title, date, time, endDate, endTime, location, category, description, visibility, groupId, invitees, signup }`), `POST /api/events/:id/signup` (`{ on }`) | events you can see; posting rules below | Events |
| `POST /api/tools/suggestions` | signed in | Suggest a tool |
| `GET /api/notices` | anyone | Today's announcements and upcoming countdowns |
| `GET/POST/DELETE /api/me/calendar`, `GET /cal/<token>.ics` | signed in; the feed needs only its token | Private calendar link (make, replace, turn off) and the feed |
| `GET /api/push`, `POST/DELETE /api/push/subscribe`, `PUT /api/push/prefs`, `POST /api/push/test` | signed in | Notifications per device and which kinds |
| `GET/POST /api/study`, `POST /api/study/:id/going`, `DELETE /api/study/:id` | signed in | Study sessions for your classes |
| `GET /api/groups/:id/board`, `POST /api/groups/:id/posts` (`{ text, announcement }`), `POST …/posts/:pid/replies`, `DELETE …/posts/:pid[/replies/:rid]`, `POST /api/groups/:id/polls`, `POST …/polls/:pid/vote` (`{ choice }`), `PUT/DELETE …/polls/:pid` | members (announcements, polls: leaders) | Group board |
| `POST /api/events`, `DELETE /api/events/:id` | post: admins and verified people (see `EVENT_POSTING`); delete: owner or admin | Events |
| `GET /api/friends`, `POST /api/friends/lookup`, `POST /api/friends/search` (`{ q }`), `POST /api/friends/request` (`{ code }` or `{ id }`), `POST /api/friends/:id/accept`, `PUT /api/friends/:id` (`{ level }`), `DELETE /api/friends/:id`, `GET /api/friends/suggestions`, `POST /api/friends/suggestions/:id/hide` | signed in | Friends |
| `GET /api/admin/status` `users`, `PUT /api/admin/users/:id` (`{ admin, verified, name, pronouns, grade, bio, interests, avatar, profileLocked, reset }`), `PUT /api/admin/links` (`{ links }`), `PUT /api/admin/tools` (`{ tools }`), `GET /api/admin/tool-suggestions`, `POST /api/admin/tool-suggestions/:id/accept`, `DELETE /api/admin/tool-suggestions/:id`, `PUT /api/admin/groups/:id` (`{ approved }`), `GET/PUT /api/admin/notices` (`{ announcements, countdowns, blockedWords }`), `DELETE /api/admin/users/:id`, `PUT /api/admin/calendar`, `GET /api/admin/backup`, `POST /api/admin/restore` | admin | Admin |

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
