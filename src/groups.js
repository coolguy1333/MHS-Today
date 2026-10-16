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
const KINDS = ['club', 'sport', 'group'];
const VISIBILITY = ['public', 'group', 'private'];
const EVENT_KEEP_DAYS = 60;   // events are removed this long after their date
const MAX_GROUPS = 500;
const MAX_MEMBERS = 1000;
const MAX_GROUP_LINKS = 10;
const MAX_INVITEES = 100;
const MAX_SIGNUP = 500;

module.exports = function groups(app) {
  const {
    route, state, db, log, config, HttpError, bad, isAdmin, getUser, canPostEvents, cleanText, cleanUrl, randomId, limiter,
    today, cal, isPlainObject, hasOwn, num, publicCard, confirmedFriends
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
    if (nameTaken(f.name)) throw new HttpError(409, 'There is already a group with that name');
    if (state.groups.length >= MAX_GROUPS) throw bad('There are too many groups');
    if (!isAdmin(user) && !limiter.hit(`group:${user.id}`, 3, 86400e3)) throw new HttpError(429, 'You can start up to 3 groups a day');
    const g = { id: randomId(), ...f, approved: isAdmin(user), members: { [user.id]: 'leader' }, requests: [], by: user.id, created: Date.now() };
    state.groups.push(g);
    log(`Group ${g.id} created by ${user.id}${g.approved ? '' : ' (waiting for approval)'}`);
    db.save();
    return groupDetail(g, user);
  });

  route('PUT', '/api/groups/:id', { auth: 'user' }, ({ user, params, body }) => {
    const g = groupOr404(params.id, user);
    if (!canManage(g, user)) throw new HttpError(403, 'Only leaders can change the group');
    const f = cleanGroupFields(body, true);
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
  function cleanEventFields(b, daysBack = 7) {
    const title = cleanText(b.title, 120);
    if (!title) throw bad('Give the event a title');
    const date = typeof b.date === 'string' ? b.date : '';
    if (cal.parseDate(date) === null) throw bad('Pick a valid date');
    const t = today();
    if (date < cal.addDays(t, -daysBack) || date > cal.addDays(t, 365 * 3)) throw bad('That date is too far away');
    const time = typeof b.time === 'string' ? b.time : '';
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('Invalid time');
    return { title, date, time, description: cleanText(b.description, 500) };
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
      id: e.id, title: e.title, date: e.date, time: e.time, description: e.description, visibility: e.visibility,
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
    const fields = cleanEventFields(body);
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
  return {
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
          out.push({
            id: g.id, ...f, approved: g.approved === true, members,
            requests: Array.isArray(g.requests) ? [...new Set(g.requests.filter((id) => hasOwn(users, id) && !hasOwn(members, id)))] : [],
            by: hasOwn(users, g.by) ? g.by : null, created: num(g.created)
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
            id: e.id, ...cleanEventFields(e, EVENT_KEEP_DAYS), by, created: num(e.created), visibility, groupId: g ? g.id : null,
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
      state.events = state.events.filter((e) => e.date >= cutoff);
    },
    forgetUser(id) {
      state.events = state.events.filter((e) => e.by !== id);
      for (const e of state.events) {
        e.invitees = e.invitees.filter((x) => x !== id);
        if (e.signup) e.signup.people = e.signup.people.filter((x) => x !== id);
      }
      for (const g of [...state.groups]) {
        g.requests = g.requests.filter((x) => x !== id);
        if (!hasOwn(g.members, id)) continue;
        delete g.members[id];
        const ids = Object.keys(g.members);
        if (!ids.length) deleteGroup(g);
        else if (!ids.some((x) => g.members[x] === 'leader')) g.members[ids[0]] = 'leader';
      }
    },
    // Events saved before groups existed are public, with no group, invitees or sign-up list.
    upgrade() {
      for (const e of state.events) {
        if (!VISIBILITY.includes(e.visibility)) e.visibility = 'public';
        if (e.groupId === undefined) e.groupId = null;
        if (!Array.isArray(e.invitees)) e.invitees = [];
        if (e.signup === undefined) e.signup = null;
      }
    }
  };
};
