// Links: the admin-managed list of important links, grouped by category in the order admins set.
(async function () {
  renderNav('links');
  try {
    const [links, me] = await Promise.all([api('GET', '/api/links'), getMe()]);
    $('admin-note').hidden = !(me.user && me.user.admin);
    const groups = new Map();
    for (const l of links) {
      if (!groups.has(l.category)) groups.set(l.category, []);
      groups.get(l.category).push(l);
    }
    fill($('links'), groups.size
      ? [...groups].map(([category, items]) => h('section', { class: 'card' },
        h('h2', null, category),
        h('div', { class: 'link-grid' }, items.map((l) => h('a', { class: 'link-card', href: l.url, target: '_blank', rel: 'noopener noreferrer' },
          h('strong', null, l.title),
          h('span', { class: 'small muted' }, l.description || new URL(l.url).hostname.replace(/^www\./, '')))))))
      : h('p', { class: 'muted' }, 'No links yet.'));
  } catch (e) {
    fill($('links'), h('p', { class: 'notice error' }, e.message));
  }
})();
