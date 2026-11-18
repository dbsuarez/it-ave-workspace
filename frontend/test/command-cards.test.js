const test = require('node:test');
const assert = require('node:assert/strict');
const { commandCardHtml, groupCommandsByCategory } = require('../src/features/command-cards');

const leave = {
  category: 'hr', kind: 'leave-balance', title: 'Leave balance', period: '2026',
  data: {
    leaveTypes: [{ name: 'Vacation Leave', entitled: 15, used: 4, pending: 0, remaining: 11 }],
    requests: [{ typeName: 'Vacation Leave', startDate: '2026-03-02', endDate: '2026-03-03', days: 2, status: 'approved' }],
    note: 'As of today',
  },
  actions: [{ type: 'open-route', route: 'leave' }, { type: 'cancel-leave', requestId: 5 }],
};

test('a leave response renders the same balances, requests, note and actions as before', () => {
  const html = commandCardHtml(leave, '/leave');
  assert.match(html, /HR Assistant/);
  assert.match(html, /Only visible to you/);
  assert.match(html, /You: \/leave/);
  assert.match(html, /<th>Vacation Leave<\/th><td>15<\/td><td>4<\/td><td>0<\/td><td>11<\/td>/);
  assert.match(html, /<strong>Vacation Leave<\/strong> · 2026-03-02 – 2026-03-03 · 2 days <span class="command-status">approved<\/span>/);
  assert.match(html, /Period: 2026/);
  assert.match(html, /command-note">As of today/);
  assert.match(html, /data-command-route="leave"/);
  assert.match(html, /data-command-cancel-leave="5"/);
});

test('non-HR responses are labelled as the workspace assistant', () => {
  assert.match(commandCardHtml({ category: 'general', title: 'Help', data: {}, actions: [] }, '/help'), /Workspace Assistant/);
  assert.match(commandCardHtml({ title: 'No category', data: {}, actions: [] }, '/x'), /Workspace Assistant/);
});

test('a generic table and list render, with every value escaped', () => {
  const html = commandCardHtml({
    title: '<b>Results</b>',
    data: {
      message: '<img src=x onerror=alert(1)>',
      table: { head: ['Name', '<i>Kind</i>'], rows: [['<script>x</script>', 'a & b']] },
      list: [{ title: '<u>One</u>', text: '"quoted"' }],
    },
    actions: [],
  }, '/search <x>');
  assert.doesNotMatch(html, /<script>|<img|<b>|<i>|<u>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /&lt;u&gt;One&lt;\/u&gt;/);
  assert.match(html, /You: \/search &lt;x&gt;/);
  assert.match(html, /<th>Name<\/th><th>&lt;i&gt;Kind&lt;\/i&gt;<\/th>/);
});

test('only allowlisted actions become buttons; unknown types and routes render nothing', () => {
  const html = commandCardHtml({
    title: 'Actions', data: {},
    actions: [
      { type: 'run-script', code: 'alert(1)' },
      { type: 'open-route', route: 'admin-secrets' },
      { type: 'open-route', route: 'search', query: 'budget "Q1"' },
      { type: 'cancel-leave', requestId: 'abc' },
    ],
  }, '/search budget');
  assert.doesNotMatch(html, /run-script|admin-secrets|abc/);
  assert.match(html, /data-command-route="search" data-command-query="budget &quot;Q1&quot;"/);
  assert.equal((html.match(/<button type="button" class="btn/g) || []).length, 1);
});

test('commands are grouped by category in a fixed order and keep their own order', () => {
  const groups = groupCommandsByCategory([
    { name: 'poll', category: 'polls' }, { name: 'leave', category: 'hr' }, { name: 'help', category: 'general' },
    { name: 'search', category: 'search' }, { name: 'announce', category: 'announcements' }, { name: 'leave-used', category: 'hr' },
    { name: 'mystery', category: 'unheard-of' },
  ]);
  assert.deepEqual(groups.map((g) => g.category), ['general', 'search', 'announcements', 'polls', 'hr', 'unheard-of']);
  assert.deepEqual(groups.find((g) => g.category === 'hr').items.map((c) => c.name), ['leave', 'leave-used']);
});
