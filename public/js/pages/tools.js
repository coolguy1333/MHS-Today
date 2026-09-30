// Tools: add an entry to TOOLS to show a card. An empty url shows "Coming soon".
(function () {
  renderNav('tools');
  const TOOLS = [
    { name: 'Class Cards', description: 'Flashcards for your classes, built as its own app.', url: '' }
  ];
  fill($('tool-grid'), TOOLS.map((t) => t.url
    ? h('a', { class: 'card tool-card', href: t.url, target: '_blank', rel: 'noopener noreferrer' }, h('h3', null, t.name), h('p', null, t.description))
    : h('div', { class: 'card tool-card' }, h('h3', null, t.name), h('p', null, t.description), h('span', { class: 'badge muted' }, 'Coming soon'))));
})();
