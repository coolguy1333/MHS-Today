// Feedback: send a bug, idea or question; see what you've sent and the answers.
(async function () {
  renderNav('feedback');
  await requireLogin();
  const TYPES = { bug: "🐞 Something's broken", idea: '💡 An idea', question: '❓ A question', other: '💬 Something else' };
  const STATUS = { new: 'Sent', seen: 'Seen', done: 'Done' };
  const when = (ms) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

  async function load() {
    try {
      const mine = await api('GET', '/api/feedback');
      fill($('mine'), mine.length ? mine.map((f) => h('div', { class: 'feedback-item' + (f.unread ? ' unread' : '') },
        h('div', { class: 'row between' }, h('strong', null, TYPES[f.type]), h('span', { class: `badge status-${f.status}` }, STATUS[f.status])),
        h('p', { class: 'pre' }, f.message),
        h('div', { class: 'small muted' }, when(f.created)),
        f.replies.map((r) => h('div', { class: 'reply' }, h('div', { class: 'small' }, h('strong', null, r.by), ` · ${when(r.at)}`), h('p', { class: 'pre' }, r.text)))))
        : h('p', { class: 'muted' }, "Nothing yet. We'd love to hear from you."));
    } catch (e) {
      fill($('mine'), h('p', { class: 'notice error' }, e.message));
    }
  }

  $('feedback-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const type = (e.target.querySelector('input[name="type"]:checked') || {}).value;
      const from = document.referrer && new URL(document.referrer).origin === location.origin ? new URL(document.referrer).pathname : '';
      await api('POST', '/api/feedback', { type, message: $('fb-message').value, page: from });
      e.target.reset();
      toast('Thanks! We got it.');
      await load();
    });
  });
  await load();
})();
