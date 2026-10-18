// Tools: the admin-managed list (a card per tool; no address = "Coming soon") and a form to suggest one.
(async function () {
  renderNav('tools');
  try {
    const [tools, me] = await Promise.all([api('GET', '/api/tools'), getMe()]);
    fill($('tool-grid'), tools.length ? tools.map((t) => t.url
      ? h('a', { class: 'card tool-card', href: t.url, target: '_blank', rel: 'noopener noreferrer' }, h('h3', null, t.name), h('p', null, t.description))
      : h('div', { class: 'card tool-card' }, h('h3', null, t.name), h('p', null, t.description), h('span', { class: 'badge muted' }, 'Coming soon')))
      : h('p', { class: 'muted' }, 'No tools yet.'));
    $('suggest-card').hidden = !me.user;
  } catch (e) {
    fill($('tool-grid'), h('p', { class: 'notice error' }, e.message));
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
