'use strict';
// Tools page: an admin-managed list of tools (a card per tool; no address = "Coming soon"), and
// tool ideas students suggest, which admins accept onto the list or dismiss.
const MAX_TOOLS = 60;
const MAX_SUGGESTIONS = 200;
const DEFAULT_TOOLS = [
  { name: 'Class Cards', url: '', description: 'Flashcards for your classes, built as its own app.' }
];

module.exports = function tools(app) {
  const { route, state, db, log, HttpError, bad, getUser, cleanText, cleanUrl, randomId, limiter, isPlainObject, hasOwn, num, publicCard, checkWords } = app;

  // Untrusted -> { id, name, url, description } or null. An empty url is allowed ("Coming soon").
  function cleanTool(t) {
    if (!isPlainObject(t)) return null;
    const name = cleanText(t.name, 60);
    const raw = typeof t.url === 'string' ? t.url.trim() : '';
    const url = raw ? cleanUrl(raw) : '';
    if (!name || url === null) return null;
    return { id: typeof t.id === 'string' && /^[0-9a-f]{16}$/.test(t.id) ? t.id : randomId(), name, url, description: cleanText(t.description, 200) };
  }

  if (!Array.isArray(state.tools)) { state.tools = DEFAULT_TOOLS.map(cleanTool); db.save(); }
  if (!Array.isArray(state.toolSuggestions)) state.toolSuggestions = [];

  route('GET', '/api/tools', { auth: 'none' }, () => state.tools);

  route('POST', '/api/tools/suggestions', { auth: 'user' }, ({ user, body }) => {
    const t = cleanTool(body);
    if (!t) throw bad('Give the tool a name, and a web address starting with https:// if it has one');
    checkWords(t.name, t.description);
    if (state.toolSuggestions.length >= MAX_SUGGESTIONS) throw bad('There are too many suggestions waiting. Try again later.');
    if (!limiter.hit(`toolidea:${user.id}`, 5, 86400e3)) throw new HttpError(429, 'You can suggest up to 5 tools a day');
    state.toolSuggestions.push({ ...t, id: randomId(), by: user.id, created: Date.now() });
    db.save();
    return { ok: true };
  });

  route('PUT', '/api/admin/tools', { auth: 'admin' }, ({ user, body }) => {
    if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) throw bad(`Send up to ${MAX_TOOLS} tools`);
    const list = body.tools.map(cleanTool);
    const badAt = list.findIndex((t) => !t);
    if (badAt >= 0) throw bad(`Tool ${badAt + 1} needs a name, and its address must start with https:// (or be empty)`);
    state.tools = list;
    log(`Tools updated by admin ${user.id} (${list.length})`);
    db.save();
    return state.tools;
  });
  route('GET', '/api/admin/tool-suggestions', { auth: 'admin' }, () => state.toolSuggestions.map((s) => ({
    id: s.id, name: s.name, url: s.url, description: s.description, created: s.created,
    by: getUser(s.by) ? publicCard(getUser(s.by)) : null
  })));
  // Accept: the idea becomes a tool at the end of the list.
  route('POST', '/api/admin/tool-suggestions/:id/accept', { auth: 'admin' }, ({ user, params }) => {
    const i = state.toolSuggestions.findIndex((s) => s.id === params.id);
    if (i < 0) throw new HttpError(404, 'Suggestion not found');
    if (state.tools.length >= MAX_TOOLS) throw bad('The tools list is full');
    const [s] = state.toolSuggestions.splice(i, 1);
    state.tools.push({ id: randomId(), name: s.name, url: s.url, description: s.description });
    log(`Tool suggestion ${s.id} accepted by admin ${user.id}`);
    db.save();
    return state.tools;
  });
  route('DELETE', '/api/admin/tool-suggestions/:id', { auth: 'admin' }, ({ params }) => {
    const i = state.toolSuggestions.findIndex((s) => s.id === params.id);
    if (i < 0) throw new HttpError(404, 'Suggestion not found');
    state.toolSuggestions.splice(i, 1);
    db.save();
    return { ok: true };
  });

  return {
    status: () => ({ toolSuggestions: state.toolSuggestions.length }),
    exportData: () => ({ tools: state.tools, toolSuggestions: state.toolSuggestions }),
    importData(data, users) {
      if (Array.isArray(data.tools)) state.tools = data.tools.map(cleanTool).filter(Boolean).slice(0, MAX_TOOLS);
      state.toolSuggestions = (Array.isArray(data.toolSuggestions) ? data.toolSuggestions : [])
        .map((s) => (isPlainObject(s) && hasOwn(users, s.by) ? { ...cleanTool(s), by: s.by, created: num(s.created) } : null))
        .filter((s) => s && s.name).slice(0, MAX_SUGGESTIONS);
    },
    maintain() {},
    forgetUser(id) { state.toolSuggestions = state.toolSuggestions.filter((s) => s.by !== id); }
  };
};
