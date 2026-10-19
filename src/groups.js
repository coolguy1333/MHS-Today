'use strict';
// Groups (clubs, sports, student groups) and events.
//
// Groups: anyone can start one; it is listed only after an admin approves it. Its creator is a
// leader. Leaders edit the group, accept join requests, promote other leaders and post its events.
//
// Events are one of:
//   public   everyone (posting follows EVENT_POSTING; leaders of approved groups may post for their group)
//   group    only that group's members
//   private  only the person who made it and the friends they invited
// Any event can have a sign-up list (optionally limited). Everyone who can see the event sees how
// many signed up; organizers (the author, the group's leaders) and admins see who.
//
// Each group also has a board for its members: posts with replies (leaders can mark a post as an
// announcement, which notifies members) and polls (leaders ask, members vote once, may change it).
const KINDS = ['club', 'sport', 'group'];
const VISIBILITY = ['public', 'group', 'private'];
// What kind of event it is (a filter on the Events page). Group events default to their group's kind.
const CATEGORIES = ['school', 'sports', 'clubs', 'community', 'holidays'];
const KIND_CATEGORY = { club: 'clubs', sport: 'sports', group: 'clubs' };
const MAX_EVENT_DAYS = 31; // a multi-day event spans at most this many days
const EVENT_KEEP_DAYS = 60;   // events are removed this long after their date
const MAX_GROUPS = 500;
const MAX_MEMBERS = 1000;
const MAX_GROUP_LINKS = 10;
const MAX_INVITEES = 100;
const MAX_SIGNUP = 500;
const MAX_POSTS = 300;
const MAX_REPLIES = 100;
const MAX_POLLS = 50;

module.exports = function groups(app) {
  const {
    route, state, db, log, config, HttpError, bad, isAdmin, getUser, canPostEvents, cleanText, cleanUrl, randomId, limiter,
    today, cal, isPlainObject, hasOwn, num, publicCard, confirmedFriends, checkWords, notify
  } = app;
  if (!Array.isArray(state.groups)) state.groups = [];
  const isId = (v) => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);

  // ---------- groups ----------
  const findGroup = (id) => state.groups.find((g) => g.id === id) || null;
  const roleIn = (g, user) => (user && hasOwn(g.members, user.id) ? g.members[user.id] : null);
  const isLeader = (g, user) => roleIn(g, user) === 'leader';
  const canManage = (g, user) => isLeader(g, user) || isAdmin(user);
  const leaders = (g) => Object.keys(g.members).filter((id) => g.members[id] === 'leader');
  // Anyone may see an approved group; a pending one only its members and admins.
  const canSeeGroup = (g, user) => g.approved || !!roleIn(g, user) || isAdmin(user);

  function cleanGroupFields(b, partial) {
    const out = {};
    if (!partial || b.name !== undefined) {
      out.name = cleanText(b.name, 60);
      if (!out.name) throw bad('Give the group a name');
    }
    if (!partial || b.kind !== undefined) {
      if (!KINDS.includes(b.kind)) throw bad('Pick club, sport or student group');
      out.kind = b.kind;
    }
    if (!partial || b.description !== undefined) out.description = cleanText(b.description, 600);
    if (!partial || b.joinPolicy !== undefined) {
      if (!['open', 'approval'].includes(b.joinPolicy)) throw bad('Pick who can join');
      out.joinPolicy = b.joinPolicy;
    }
    if (!partial || b.links !== undefined) {
      const links = b.links === undefined ? [] : b.links;
      if (!Array.isArray(links) || links.length > MAX_GROUP_LINKS) throw bad(`Add up to ${MAX_GROUP_LINKS} links`);
      out.links = links.map((l, i) => {
        const title = isPlainObject(l) ? cleanText(l.title, 60) : '';
        const url = isPlainObject(l) ? cleanUrl(l.url) : null;
        if (!title || !url) throw bad(`Link ${i + 1} needs a title and a web address starting with https://`);
        return { title, url };
      });
    }
    return out;
  }
  function nameTaken(name, exceptId) {
    const n = name.toLowerCase();
    return state.groups.some((g) => g.id !== exceptId && g.name.toLowerCase() === n);
  }

  function groupCard(g, user) {
    const role = roleIn(g, user);
    return {
      id: g.id, name: g.name, kind: g.kind, description: g.description, joinPolicy: g.joinPolicy, approved: g.approved,
      memberCount: Object.keys(g.members).length,
      myRole: role || (user && g.requests.includes(user.id) ? 'requested' : null)
    };
  }
  function groupDetail(g, user) {
    const manage = canManage(g, user);
    const seeMembers = !!roleIn(g, user) || isAdmin(user);
    return {
      ...groupCard(g, user), links: g.links, canManage: manage,
      members: seeMembers
        ? Object.entries(g.members).map(([id, role]) => (getUser(id) ? { ...publicCard(getUser(id)), role } : null)).filter(Boolean)
          .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'leader' ? -1 : 1))
        : null,
      requests: manage ? g.requests.map(getUser).filter(Boolean).map(publicCard) : null
    };
  }
  const groupOr404 = (id, user) => {
    const g = findGroup(id);
    if (!g || !canSeeGroup(g, user)) throw new HttpError(404, 'Group not found');
    return g;
  };
  function deleteGroup(g) {
    state.groups = state.groups.filter((x) => x !== g);
    state.events = state.events.filter((e) => e.groupId !== g.id);
  }

  route('GET', '/api/groups', { auth: 'user' }, ({ user }) => state.groups
    .filter((g) => canSeeGroup(g, user))
    .map((g) => groupCard(g, user))
    .sort((a, b) => a.name.localeCompare(b.name)));

  route('GET', '/api/groups/:id', { auth: 'user' }, ({ user, params }) => groupDetail(groupOr404(params.id, user), user));

  route('POST', '/api/groups', { auth: 'user' }, ({ user, body }) => {
    const f = cleanGroupFields(body, false);
    checkWords(f.name, f.description, f.links.map((l) => l.title));
    if (nameTaken(f.name)) throw new HttpError(409, 'There is already a group with that name');
    if (state.groups.length >= MAX_GROUPS) throw bad('There are too many groups');
    if (!isAdmin(user) && !limiter.hit(`group:${user.id}`, 3, 86400e3)) throw new HttpError(429, 'You can start up to 3 groups a day');
    const g = { id: randomId(), ...f, approved: isAdmin(user), members: { [user.id]: 'leader' }, requests: [], posts: [], polls: [], by: user.id, created: Date.now() };
    state.groups.push(g);
    log(`Group ${g.id} created by ${user.id}${g.approved ? '' : ' (waiting for approval)'}`);
    db.save();
    return groupDetail(g, user);
  });

  route('PUT', '/api/groups/:id', { auth: 'user' }, ({ user, params, body }) => {
    const g = groupOr404(params.id, user);
    if (!canManage(g, user)) throw new HttpError(403, 'Only leaders can change the group');
    const f = cleanGroupFields(body, true);
    checkWords(f.name, f.description, (f.links || []).map((l) => l.title));
    if (f.name && nameTaken(f.name, g.id)) throw new HttpError(409, 'There is already a group with that name');
    Object.assign(g, f);
    if (f.joinPolicy === 'open' && g.requests.length) {
      for (const id of g.requests) if (Object.keys(g.members).length < MAX_MEMBERS) g.members[id] = 'member';
      g.requests = [];
    }
    db.save();
    return groupDetail(g, user);
  });

  route('DELETE', '/api/groups/:id', { auth: 'user' }, ({ user, params }) => {
    const g = groupOr404(params.id, user);
    if (!canManage(g, user)) throw new HttpError(403, 'Only leaders can delete the group');
    deleteGroup(g);
    log(`Group ${g.id} deleted by ${user.id}`);
    db.save();
    return { ok: true };
  });

  route('POST', '/api/groups/:id/join', { auth: 'user' }, ({ user, params }) => {
    const g = groupOr404(params.id, user);
    if (!g.approved) throw bad('This group is waiting for an admin to approve it');
    if (!roleIn(g, user) && !g.requests.includes(user.id)) {
      if (Object.keys(g.members).length >= MAX_MEMBERS) throw bad('This group is full');
      if (g.joinPolicy === 'open') g.members[user.id] = 'member';
      else g.requests.push(user.id);
      db.save();
    }
    return groupDetail(g, user);
  });

  route('POST', '/api/groups/:id/leave', { auth: 'user' }, ({ user, params }) => {
    const g = groupOr404(params.id, user);
    g.requests = g.requests.filter((id) => id !== user.id);
    if (roleIn(g, user)) {
      const others = Object.keys(g.members).filter((id) => id !== user.id);
      if (isLeader(g, user) && others.length && leaders(g).length === 1) throw bad('Make someone else a leader before you leave');
      delete g.members[user.id];
      if (!others.length) { deleteGroup(g); log(`Group ${g.id} removed: its last member left`); }
    }
    db.save();
    return { ok: true };
  });

  // Leaders: accept a request (role 'member'), promote/demote ('leader'/'member'), or remove (role null).
  route('PUT', '/api/groups/:id/members/:uid', { auth: 'user' }, ({ user, params, body }) => {
    const g = groupOr404(params.id, user);
    if (!canManage(g, user)) throw new HttpError(403, 'Only leaders can manage members');
    const target = getUser(params.uid);
    const known = target && (hasOwn(g.members, target.id) || g.requests.includes(target.id));
    if (!known) throw new HttpError(404, 'Not a member and no request');
    if (body.role !== null && !['leader', 'member'].includes(body.role)) throw bad('Invalid role');
    if (g.members[target.id] === 'leader' && body.role !== 'leader' && leaders(g).length === 1) throw bad('A group needs at least one leader');
    g.requests = g.requests.filter((id) => id !== target.id);
    if (body.role === null) delete g.members[target.id];
    else {
      if (!hasOwn(g.members, target.id) && Object.keys(g.members).length >= MAX_MEMBERS) throw bad('This group is full');
      g.members[target.id] = body.role;
    }
    db.save();
    return groupDetail(g, user);
  });

  route('PUT', '/api/admin/groups/:id', { auth: 'admin' }, ({ user, params, body }) => {
    const g = findGroup(params.id);
    if (!g) throw new HttpError(404, 'Group not found');
    if (typeof body.approved !== 'boolean') throw bad('Invalid setting');
    g.approved = body.approved;
    log(`Group ${g.id} ${g.approved ? 'approved' : 'unapproved'} by admin ${user.id}`);
    db.save();
    return groupDetail(g, user);
  });

  // ---------- the board: posts, replies, polls ----------
  const card = (id) => (getUser(id) ? publicCard(getUser(id)) : { id: null, name: 'Former student', grade: null, avatar: null });
  const boardOr403 = (id, user) => {
    const g = groupOr404(id, user);
    if (!roleIn(g, user) && !isAdmin(user)) throw new HttpError(403, 'Join the group to see its board');
    return g;
  };
  const canRemove = (g, user, authorId) => authorId === user.id || canManage(g, user);
  function boardView(g, user) {
    return {
      posts: g.posts.slice().sort((a, b) => (b.announcement - a.announcement) || b.created - a.created).map((p) => ({
        id: p.id, text: p.text, announcement: p.announcement, created: p.created, by: card(p.by), canDelete: canRemove(g, user, p.by),
        replies: p.replies.map((r) => ({ id: r.id, text: r.text, created: r.created, by: card(r.by), canDelete: canRemove(g, user, r.by) }))
      })),
      polls: g.polls.slice().sort((a, b) => b.created - a.created).map((p) => {
        const counts = p.options.map(() => 0);
        for (const v of Object.values(p.votes)) if (counts[v] !== undefined) counts[v]++;
        return {
          id: p.id, question: p.question, options: p.options, counts, closed: p.closed, created: p.created, by: card(p.by),
          myVote: hasOwn(p.votes, user.id) ? p.votes[user.id] : null, canManage: canManage(g, user)
        };
      })
    };
  }
  const postText = (t) => {
    // each line is cleaned on its own so line breaks survive; at most one blank line in a row
    const lines = (typeof t === 'string' ? t.split(/\r?\n/) : []).map((l) => cleanText(l, 1000));
    const text = Array.from(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()).slice(0, 1000).join('').trim();
    if (!text) throw bad('Write something first');
    checkWords(text);
    return text;
  };

  route('GET', '/api/groups/:id/board', { auth: 'user' }, ({ user, params }) => boardView(boardOr403(params.id, user), user));

  route('POST', '/api/groups/:id/posts', { auth: 'user' }, ({ user, params, body }) => {
    const g = boardOr403(params.id, user);
    const announcement = body.announcement === true;
    if (announcement && !canManage(g, user)) throw new HttpError(403, 'Only leaders can post announcements');
    const text = postText(body.text);
    if (!isAdmin(user) && !limiter.hit(`post:${user.id}`, 30, 3600e3)) throw new HttpError(429, 'Slow down a little');
    g.posts.push({ id: randomId(), by: user.id, text, announcement, created: Date.now(), replies: [] });
    if (g.posts.length > MAX_POSTS) { // drop the oldest ordinary post
      const i = g.posts.findIndex((p) => !p.announcement);
      g.posts.splice(i >= 0 ? i : 0, 1);
    }
    db.save();
    if (announcement) {
      notify(Object.keys(g.members).filter((id) => id !== user.id), 'groups',
        { title: `${g.name}: announcement`, body: text.slice(0, 180), url: `/group.html?id=${g.id}` });
    }
    return boardView(g, user);
  });
  route('POST', '/api/groups/:id/posts/:pid/replies', { auth: 'user' }, ({ user, params, body }) => {
    const g = boardOr403(params.id, user);
    const p = g.posts.find((x) => x.id === params.pid);
    if (!p) throw new HttpError(404, 'Post not found');
    if (p.replies.length >= MAX_REPLIES) throw bad('This post has too many replies');
    const text = postText(body.text);
    if (!isAdmin(user) && !limiter.hit(`post:${user.id}`, 30, 3600e3)) throw new HttpError(429, 'Slow down a little');
    p.replies.push({ id: randomId(), by: user.id, text, created: Date.now() });
    db.save();
    return boardView(g, user);
  });
  route('DELETE', '/api/groups/:id/posts/:pid', { auth: 'user' }, ({ user, params }) => {
    const g = boardOr403(params.id, user);
    const i = g.posts.findIndex((x) => x.id === params.pid);
    if (i < 0) throw new HttpError(404, 'Post not found');
    if (!canRemove(g, user, g.posts[i].by)) throw new HttpError(403, 'You can only delete your own posts');
    g.posts.splice(i, 1);
    db.save();
    return boardView(g, user);
  });
  route('DELETE', '/api/groups/:id/posts/:pid/replies/:rid', { auth: 'user' }, ({ user, params }) => {
    const g = boardOr403(params.id, user);
    const p = g.posts.find((x) => x.id === params.pid);
    const i = p ? p.replies.findIndex((r) => r.id === params.rid) : -1;
    if (i < 0) throw new HttpError(404, 'Reply not found');
    if (!canRemove(g, user, p.replies[i].by)) throw new HttpError(403, 'You can only delete your own replies');
    p.replies.splice(i, 1);
    db.save();
    return boardView(g, user);
  });

  route('POST', '/api/groups/:id/polls', { auth: 'user' }, ({ user, params, body }) => {
    const g = boardOr403(params.id, user);
    if (!canManage(g, user)) throw new HttpError(403, 'Only leaders can start polls');
    const question = cleanText(body.question, 200);
    if (!question) throw bad('Ask a question');
    const options = Array.isArray(body.options) ? [...new Set(body.options.map((o) => cleanText(o, 80)).filter(Boolean))] : [];
    if (options.length < 2 || options.length > 8) throw bad('Give 2 to 8 different choices');
    checkWords(question, options);
    if (g.polls.length >= MAX_POLLS) g.polls.shift();
    g.polls.push({ id: randomId(), by: user.id, question, options, votes: {}, closed: false, created: Date.now() });
    db.save();
    return boardView(g, user);
  });
  route('POST', '/api/groups/:id/polls/:pid/vote', { auth: 'user' }, ({ user, params, body }) => {
    const g = boardOr403(params.id, user);
    const p = g.polls.find((x) => x.id === params.pid);
    if (!p) throw new HttpError(404, 'Poll not found');
    if (p.closed) throw bad('This poll is closed');
    if (!Number.isInteger(body.choice) || body.choice < 0 || body.choice >= p.options.length) throw bad('Pick one of the choices');
    p.votes[user.id] = body.choice;
    db.save();
    return boardView(g, user);
  });
  route('PUT', '/api/groups/:id/polls/:pid', { auth: 'user' }, ({ user, params, body }) => {
    const g = boardOr403(params.id, user);
    const p = g.polls.find((x) => x.id === params.pid);
    if (!p) throw new HttpError(404, 'Poll not found');
    if (!canManage(g, user)) throw new HttpError(403, 'Only leaders can close polls');
    if (typeof body.closed !== 'boolean') throw bad('Invalid setting');
    p.closed = body.closed;
    db.save();
    return boardView(g, user);
  });
  route('DELETE', '/api/groups/:id/polls/:pid', { auth: 'user' }, ({ user, params }) => {
    const g = boardOr403(params.id, user);
    if (!canManage(g, user)) throw new HttpError(403, 'Only leaders can delete polls');
    g.polls = g.polls.filter((x) => x.id !== params.pid);
    db.save();
    return boardView(g, user);
  });

  // ---------- events ----------
  const organizers = (e) => {
    const g = e.groupId ? findGroup(e.groupId) : null;
    return new Set([e.by, ...(g ? leaders(g) : [])]);
  };
  const canEdit = (e, user) => !!user && (organizers(e).has(user.id) || isAdmin(user));
  function canSee(e, user) {
    if (e.visibility === 'public') return true;
    if (!user) return false;
    if (e.visibility === 'group') { const g = findGroup(e.groupId); return !!g && (!!roleIn(g, user) || isAdmin(user)); }
    return e.by === user.id || e.invitees.includes(user.id);
  }

  // Returns the cleaned event fields or throws 400. `daysBack` = how far in the past a date may be.
  // An event can have an end time, and end on a later day (endDate, null = same day).
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  function cleanEventFields(b, daysBack = 7, fallbackCategory = 'school') {
    const title = cleanText(b.title, 120);
    if (!title) throw bad('Give the event a title');
    const date = typeof b.date === 'string' ? b.date : '';
    if (cal.parseDate(date) === null) throw bad('Pick a valid date');
    const t = today();
    if (date < cal.addDays(t, -daysBack) || date > cal.addDays(t, 365 * 3)) throw bad('That date is too far away');
    const time = typeof b.time === 'string' ? b.time : '';
    if (time && !TIME.test(time)) throw bad('Invalid time');
    let endDate = typeof b.endDate === 'string' && b.endDate ? b.endDate : null;
    if (endDate !== null) {
      if (cal.parseDate(endDate) === null) throw bad('Pick a valid end date');
      if (endDate < date) throw bad('The event can\'t end before it starts');
      if (endDate > cal.addDays(date, MAX_EVENT_DAYS - 1)) throw bad(`An event can last up to ${MAX_EVENT_DAYS} days`);
      if (endDate === date) endDate = null;
    }
    const endTime = typeof b.endTime === 'string' ? b.endTime : '';
    if (endTime && !TIME.test(endTime)) throw bad('Invalid end time');
    if (endTime && !time) throw bad('Add a start time to give the event an end time');
    if (endTime && !endDate && endTime <= time) throw bad('The end time must be after the start time');
    const category = CATEGORIES.includes(b.category) ? b.category : fallbackCategory;
    return { title, date, time, endDate, endTime, category, location: cleanText(b.location, 120), description: cleanText(b.description, 500) };
  }
  function cleanSignup(s) {
    if (s === undefined || s === null || s === false) return null;
    if (s === true) return { limit: 0, people: [] };
    if (!isPlainObject(s)) throw bad('Invalid sign-up list');
    const limit = s.limit === undefined || s.limit === null || s.limit === '' ? 0 : Number(s.limit);
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_SIGNUP) throw bad(`A sign-up limit is a number from 1 to ${MAX_SIGNUP} (or empty for no limit)`);
    return { limit, people: [] };
  }

  const byDateTime = (a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`);
  function eventView(e, user) {
    const g = e.groupId ? findGroup(e.groupId) : null;
    const org = !!user && (organizers(e).has(user.id) || isAdmin(user));
    const author = getUser(e.by);
    return {
      id: e.id, title: e.title, date: e.date, time: e.time, endDate: e.endDate, endTime: e.endTime, category: e.category, location: e.location,
      description: e.description, visibility: e.visibility,
      group: g ? { id: g.id, name: g.name } : null,
      by: user ? (author ? author.name : 'Former student') : undefined,
      mine: canEdit(e, user),
      invitees: org && e.visibility === 'private' ? e.invitees.map(getUser).filter(Boolean).map(publicCard) : undefined,
      signup: e.signup ? {
        limit: e.signup.limit, count: e.signup.people.length, me: !!user && e.signup.people.includes(user.id),
        people: org ? e.signup.people.map(getUser).filter(Boolean).map(publicCard) : undefined
      } : null
    };
  }

  // Everything the viewer may see; ?group=<id> for one group's calendar.
  route('GET', '/api/events', { auth: 'none' }, ({ user, url }) => {
    const only = url.searchParams.get('group');
    return state.events
      .filter((e) => canSee(e, user) && (!only || e.groupId === only))
      .sort(byDateTime).map((e) => eventView(e, user));
  });

  route('POST', '/api/events', { auth: 'user' }, ({ user, body }) => {
    const visibility = body.visibility === undefined ? 'public' : body.visibility;
    if (!VISIBILITY.includes(visibility)) throw bad('Pick who can see the event');
    let groupId = null;
    if (body.groupId !== undefined && body.groupId !== null && body.groupId !== '') {
      const g = findGroup(body.groupId);
      if (!g || !canManage(g, user)) throw new HttpError(403, 'Only leaders can add events for this group');
      if (visibility === 'public' && !g.approved) throw bad('A group needs an admin\'s approval before it can post public events');
      groupId = g.id;
    }
    if (visibility === 'group' && !groupId) throw bad('Pick a group');
    if (visibility === 'public' && !groupId && !canPostEvents(user)) {
      throw new HttpError(403, config.eventPosting === 'admins' ? 'Only admins can add events' : 'Only verified people can add events. Ask an admin to verify you.');
    }
    let invitees = [];
    if (visibility === 'private') {
      if (groupId) throw bad('A private event can\'t belong to a group');
      const list = body.invitees === undefined ? [] : body.invitees;
      if (!Array.isArray(list) || list.length > MAX_INVITEES) throw bad(`Invite up to ${MAX_INVITEES} friends`);
      const friends = new Set(confirmedFriends(user));
      invitees = [...new Set(list)];
      if (!invitees.every((id) => friends.has(id))) throw bad('You can only invite your friends');
    }
    const g = groupId ? findGroup(groupId) : null;
    const fields = cleanEventFields(body, 7, g ? KIND_CATEGORY[g.kind] : 'school');
    checkWords(fields.title, fields.description, fields.location);
    const signup = cleanSignup(body.signup);
    if (state.events.length >= config.maxEvents) throw bad('The events board is full');
    if (!isAdmin(user) && !limiter.hit(`event:${user.id}`, 10, 86400e3)) throw new HttpError(429, 'You can add up to 10 events a day');
    const ev = { id: randomId(), ...fields, by: user.id, created: Date.now(), visibility, groupId, invitees, signup };
    state.events.push(ev);
    db.save();
    return { id: ev.id };
  });

  route('DELETE', '/api/events/:id', { auth: 'user' }, ({ user, params }) => {
    const i = state.events.findIndex((e) => e.id === params.id);
    if (i < 0) throw new HttpError(404, 'Event not found');
    if (!canEdit(state.events[i], user)) throw new HttpError(403, 'You can only delete your own events');
    state.events.splice(i, 1);
    db.save();
    return { ok: true };
  });

  route('POST', '/api/events/:id/signup', { auth: 'user' }, ({ user, params, body }) => {
    const e = state.events.find((x) => x.id === params.id);
    if (!e || !canSee(e, user)) throw new HttpError(404, 'Event not found');
    if (!e.signup) throw bad('This event has no sign-up list');
    if (typeof body.on !== 'boolean') throw bad('Invalid request');
    const has = e.signup.people.includes(user.id);
    if (body.on && !has) {
      if (e.signup.limit && e.signup.people.length >= e.signup.limit) throw new HttpError(409, 'This sign-up list is full');
      e.signup.people.push(user.id);
    } else if (!body.on && has) e.signup.people = e.signup.people.filter((id) => id !== user.id);
    db.save();
    return eventView(e, user);
  });

  // ---------- backup, cleanup ----------
  // Events for someone's calendar feed: theirs, ones they signed up for or were invited to, and their groups'.
  const mineForCalendar = (e, user) => e.by === user.id || e.invitees.includes(user.id) || (e.signup && e.signup.people.includes(user.id))
    || (e.groupId && !!findGroup(e.groupId) && !!roleIn(findGroup(e.groupId), user));
  return {
    // timed events and who to remind: the author, people signed up, people invited
    eventsForReminders: () => state.events.filter((e) => e.time).map((e) => ({
      id: e.id, date: e.date, time: e.time, title: e.title,
      people: [...new Set([e.by, ...e.invitees, ...(e.signup ? e.signup.people : [])].filter(Boolean))]
    })),
    calendarItems: (user) => state.events.filter((e) => canSee(e, user) && mineForCalendar(e, user)).map((e) => {
      const g = e.groupId ? findGroup(e.groupId) : null;
      return {
        uid: `ev-${e.id}`, date: e.date, time: e.time || null, endDate: e.endDate, endTime: e.endTime, title: e.title, location: e.location,
        description: [g ? g.name : '', e.description].filter(Boolean).join(': ')
      };
    }),
    status: () => ({ groups: state.groups.length, pendingGroups: state.groups.filter((g) => !g.approved).length }),
    exportData: () => ({ groups: state.groups }),
    importData(data, users) {
      const out = [];
      for (const g of Array.isArray(data.groups) ? data.groups.slice(0, MAX_GROUPS) : []) {
        try {
          if (!isPlainObject(g) || !isId(g.id) || out.some((x) => x.id === g.id)) continue;
          const f = cleanGroupFields(g, false);
          if (out.some((x) => x.name.toLowerCase() === f.name.toLowerCase())) continue;
          const members = {};
          for (const [id, role] of Object.entries(isPlainObject(g.members) ? g.members : {})) {
            if (hasOwn(users, id) && ['leader', 'member'].includes(role)) members[id] = role;
          }
          const ids = Object.keys(members);
          if (!ids.length) continue;
          if (!ids.some((id) => members[id] === 'leader')) members[ids[0]] = 'leader';
          const text = (t) => cleanText(t, 1000);
          const posts = (Array.isArray(g.posts) ? g.posts : []).filter((p) => isPlainObject(p) && isId(p.id) && text(p.text)).slice(-MAX_POSTS).map((p) => ({
            id: p.id, by: hasOwn(users, p.by) ? p.by : null, text: text(p.text), announcement: p.announcement === true, created: num(p.created),
            replies: (Array.isArray(p.replies) ? p.replies : []).filter((r) => isPlainObject(r) && isId(r.id) && text(r.text)).slice(-MAX_REPLIES)
              .map((r) => ({ id: r.id, by: hasOwn(users, r.by) ? r.by : null, text: text(r.text), created: num(r.created) }))
          }));
          const polls = (Array.isArray(g.polls) ? g.polls : []).filter((p) => isPlainObject(p) && isId(p.id) && Array.isArray(p.options)).slice(-MAX_POLLS).map((p) => {
            const options = p.options.map((o) => cleanText(o, 80)).filter(Boolean).slice(0, 8);
            const votes = {};
            for (const [id, v] of Object.entries(isPlainObject(p.votes) ? p.votes : {})) if (hasOwn(users, id) && Number.isInteger(v) && v >= 0 && v < options.length) votes[id] = v;
            return { id: p.id, by: hasOwn(users, p.by) ? p.by : null, question: cleanText(p.question, 200) || 'Poll', options, votes, closed: p.closed === true, created: num(p.created) };
          }).filter((p) => p.options.length >= 2);
          out.push({
            id: g.id, ...f, approved: g.approved === true, members,
            requests: Array.isArray(g.requests) ? [...new Set(g.requests.filter((id) => hasOwn(users, id) && !hasOwn(members, id)))] : [],
            posts, polls, by: hasOwn(users, g.by) ? g.by : null, created: num(g.created)
          });
        } catch { /* skip invalid groups */ }
      }
      state.groups = out;
      // events: validated like fresh input, against the restored people and groups
      const events = [];
      let dropped = 0;
      for (const e of Array.isArray(data.events) ? data.events.slice(0, config.maxEvents) : []) {
        try {
          if (!isPlainObject(e) || !isId(e.id)) throw bad('id');
          const visibility = VISIBILITY.includes(e.visibility) ? e.visibility : 'public';
          const g = e.groupId ? out.find((x) => x.id === e.groupId) : null;
          if (visibility === 'group' && !g) throw bad('group');
          const by = hasOwn(users, e.by) ? e.by : null;
          if (visibility === 'private' && !by) throw bad('author');
          const signup = isPlainObject(e.signup) ? cleanSignup({ limit: e.signup.limit }) : null;
          if (signup && Array.isArray(e.signup.people)) signup.people = [...new Set(e.signup.people.filter((id) => hasOwn(users, id)))];
          events.push({
            id: e.id, ...cleanEventFields(e, EVENT_KEEP_DAYS, g ? KIND_CATEGORY[g.kind] : 'school'), by, created: num(e.created), visibility, groupId: g ? g.id : null,
            invitees: visibility === 'private' && Array.isArray(e.invitees) ? [...new Set(e.invitees.filter((id) => hasOwn(users, id)))].slice(0, MAX_INVITEES) : [],
            signup
          });
        } catch { dropped++; }
      }
      state.events = events;
      return { events: events.length, droppedEvents: dropped };
    },
    maintain() {
      const cutoff = cal.addDays(today(), -EVENT_KEEP_DAYS);
      state.events = state.events.filter((e) => (e.endDate || e.date) >= cutoff);
    },
    forgetUser(id) {
      state.events = state.events.filter((e) => e.by !== id);
      for (const e of state.events) {
        e.invitees = e.invitees.filter((x) => x !== id);
        if (e.signup) e.signup.people = e.signup.people.filter((x) => x !== id);
      }
      for (const g of [...state.groups]) {
        g.requests = g.requests.filter((x) => x !== id);
        g.posts = g.posts.filter((p) => p.by !== id);
        for (const p of g.posts) p.replies = p.replies.filter((r) => r.by !== id);
        for (const p of g.polls) delete p.votes[id];
        if (!hasOwn(g.members, id)) continue;
        delete g.members[id];
        const ids = Object.keys(g.members);
        if (!ids.length) deleteGroup(g);
        else if (!ids.some((x) => g.members[x] === 'leader')) g.members[ids[0]] = 'leader';
      }
    },
    // Events saved before groups existed are public, with no group, invitees or sign-up list.
    upgrade() {
      for (const g of state.groups) {
        if (!Array.isArray(g.posts)) g.posts = [];
        if (!Array.isArray(g.polls)) g.polls = [];
      }
      for (const e of state.events) {
        if (!VISIBILITY.includes(e.visibility)) e.visibility = 'public';
        if (e.groupId === undefined) e.groupId = null;
        if (!Array.isArray(e.invitees)) e.invitees = [];
        if (e.signup === undefined) e.signup = null;
        // added with end times and categories
        if (e.endDate === undefined) e.endDate = null;
        if (typeof e.endTime !== 'string') e.endTime = '';
        if (typeof e.location !== 'string') e.location = '';
        if (!CATEGORIES.includes(e.category)) { const g = e.groupId ? findGroup(e.groupId) : null; e.category = g ? KIND_CATEGORY[g.kind] : 'school'; }
      }
    }
  };
};
