const test = require('node:test');
const assert = require('node:assert/strict');
const { peopleTogglesHtml, peopleCardsHtml, peopleListHtml } = require('../src/features/people-view');

const helpers = {
  escape: (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  name: (p) => p.firstName ? `${p.firstName} ${p.lastName}` : p.username,
  avatar: (p, size) => `<span class="av av-${size}">${p.username[0]}</span>`,
  presence: () => '<i class="dot"></i>',
};
const ann = { id: 1, username: 'ann', firstName: 'Ann', lastName: 'Lee', jobTitle: 'Designer', department: 'Creative', location: 'Manila' };
const bob = { id: 2, username: 'bob', firstName: '', lastName: '', jobTitle: '', department: '', location: '' };
const leaver = { id: 3, username: 'cy', firstName: 'Cy', lastName: 'Tan', jobTitle: 'Analyst', department: 'MIS', location: '', inactive: true };

test('the view toggle shows Cards and List with the current one pressed', () => {
  const cards = peopleTogglesHtml({ view: 'card', status: 'active', canSeeInactive: false });
  assert.match(cards, /data-people-view="card"[^>]*aria-pressed="true"/);
  assert.match(cards, /data-people-view="list"[^>]*aria-pressed="false"/);
  const list = peopleTogglesHtml({ view: 'list', status: 'active', canSeeInactive: false });
  assert.match(list, /data-people-view="list"[^>]*aria-pressed="true"/);
  assert.match(list, /data-people-view="card"[^>]*aria-pressed="false"/);
});

test('the Active/Inactive toggle exists only for people who may see inactive employees', () => {
  assert.doesNotMatch(peopleTogglesHtml({ view: 'card', status: 'active', canSeeInactive: false }), /data-people-status/);
  const html = peopleTogglesHtml({ view: 'card', status: 'active', canSeeInactive: true });
  assert.match(html, /data-people-status="active"[^>]*aria-pressed="true"/);
  assert.match(html, /data-people-status="inactive"[^>]*aria-pressed="false"/);
  assert.match(peopleTogglesHtml({ view: 'card', status: 'inactive', canSeeInactive: true }), /data-people-status="inactive"[^>]*aria-pressed="true"/);
});

test('cards keep their familiar markup: name, title, department, location, and a button that opens the person', () => {
  const html = peopleCardsHtml([ann, bob], helpers);
  assert.match(html, /<div class="pp-grid">/);
  assert.match(html, /<button type="button" class="pp-card" data-person="1">/);
  assert.match(html, /<span class="pp-card-name">Ann Lee <i class="dot"><\/i><\/span>/);
  assert.match(html, /<span class="pp-card-title">Designer<\/span>/);
  assert.match(html, /<span class="pp-card-meta">Creative<\/span>/);
  assert.match(html, /<span class="pp-card-meta">Manila<\/span>/);
  assert.match(html, /No title yet/, 'someone with no title gets the placeholder');
});

test('the list has a header and one row per person with the same facts', () => {
  const html = peopleListHtml([ann, bob], helpers);
  assert.match(html, /<div class="pp-list" role="table">/);
  for (const heading of ['Name', 'Title', 'Department', 'Location']) assert.match(html, new RegExp(`>${heading}<`));
  assert.equal((html.match(/data-person="/g) || []).length, 2);
  assert.match(html, /<button type="button" class="pp-prow" data-person="1" role="row">/);
  assert.match(html, /Ann Lee/);
  assert.match(html, /Designer/);
  assert.match(html, /Creative/);
  assert.match(html, /Manila/);
  assert.match(html, /<span class="pp-muted">No title yet<\/span>/);
});

test('inactive people are shown but cannot be opened, and are labelled', () => {
  const cards = peopleCardsHtml([leaver], helpers);
  assert.doesNotMatch(cards, /data-person=/);
  assert.match(cards, /class="pp-card pp-card-inactive"/);
  assert.match(cards, /pp-badge-inactive">Inactive</);
  const list = peopleListHtml([leaver], helpers);
  assert.doesNotMatch(list, /data-person=/);
  assert.match(list, /class="pp-prow pp-prow-inactive"/);
  assert.match(list, /pp-badge-inactive">Inactive</);
});

test('every value is escaped in both views', () => {
  const evil = { id: 9, username: 'x', firstName: '<b>Bad</b>', lastName: '"', jobTitle: '<script>1</script>', department: '<i>d</i>', location: '&' };
  for (const html of [peopleCardsHtml([evil], helpers), peopleListHtml([evil], helpers)]) {
    assert.doesNotMatch(html, /<b>|<script>|<i>d/);
    assert.match(html, /&lt;script&gt;1&lt;\/script&gt;/);
  }
});
