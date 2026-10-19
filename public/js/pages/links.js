// Links & tools: the admin-managed tools (a card each; no address = "Coming soon") and important
// links grouped by category, both in the order admins set, plus a form to suggest a tool.
(async function () {
  renderNav('links');
  const host = (url) => new URL(url).hostname.replace(/^www\./, '');
  const card = (title, url, description) => (url
    ? h('a', { class: 'link-card', href: url, target: '_blank', rel: 'noopener noreferrer' },
      h('strong', null, title), h('span', { class: 'small muted' }, description || host(url)))
    : h('div', { class: 'link-card' }, h('strong', null, title),
      h('span', { class: 'small muted' }, description), h('span', null, h('span', { class: 'badge muted' }, 'Coming soon'))));
  const section = (title, cards, id) => h('section', { class: 'card', id }, h('h2', null, title), h('div', { class: 'link-grid' }, cards));
  try {
    const [tools, links, me] = await Promise.all([api('GET', '/api/tools'), api('GET', '/api/links'), getMe()]);
    $('admin-note').hidden = !(me.user && me.user.admin);
    $('suggest-card').hidden = !me.user;
    const groups = new Map();
    for (const l of links) {
      if (!groups.has(l.category)) groups.set(l.category, []);
      groups.get(l.category).push(l);
    }
    const sections = [
      tools.length ? section('Tools', tools.map((t) => card(t.name, t.url, t.description)), 'tools')
        : h('section', { class: 'card', id: 'tools' }, h('h2', null, 'Tools'), h('p', { class: 'muted' }, me.user && me.user.admin
          ? ['No tools yet. Add some on the ', h('a', { href: 'admin.html#tools-card' }, 'Admin page'), '.']
          : 'No tools yet. Suggest one below!')),
      ...[...groups].map(([category, items]) => section(category, items.map((l) => card(l.title, l.url, l.description))))
    ].filter(Boolean);
    fill($('links'), sections);
    if (location.hash === '#tools' && $('tools')) $('tools').scrollIntoView();
  } catch (e) {
    fill($('links'), h('p', { class: 'notice error' }, e.message));
  }

  $('suggest-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api('POST', '/api/tools/suggestions', { name: $('t-name').value, url: $('t-url').value, description: $('t-description').value });
      e.target.reset();
      toast('Thanks! An admin will take a look.');
    });
  });
})();
