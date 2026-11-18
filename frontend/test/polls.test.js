const test = require('node:test');
const assert = require('node:assert/strict');
const { pollCardHtml } = require('../src/features/polls');

const poll = (overrides = {}) => ({
  id: 7, question: 'Lunch on Friday?', multiple: false, anonymous: false, closed: false, closesAt: null, myOptionIds: [2], totalVoters: 4,
  options: [
    { id: 1, label: 'Pizza', count: 1, voters: ['ann'] },
    { id: 2, label: 'Sushi', count: 3, voters: ['bob', 'cara', 'dan'] },
  ],
  ...overrides,
});

test('shows the question, each option with its count and share, and marks your choice', () => {
  const html = pollCardHtml(poll(), { canClose: false });
  assert.match(html, /data-poll-id="7"/);
  assert.match(html, /Lunch on Friday\?/);
  assert.match(html, /data-poll-vote="1"[^>]*aria-pressed="false"/);
  assert.match(html, /data-poll-vote="2"[^>]*aria-pressed="true"/);
  assert.match(html, /class="poll-option selected"[^>]*data-poll-vote="2"/);
  assert.match(html, /<span class="poll-count">3 \(75%\)<\/span>/);
  assert.match(html, /<span class="poll-count">1 \(25%\)<\/span>/);
  assert.match(html, /style="width:75%"/);
  assert.match(html, /4 people voted/);
  assert.match(html, /Pick one/);
});

test('named polls list who voted; anonymous polls say so and show no names', () => {
  assert.match(pollCardHtml(poll()), /<small class="poll-voters">bob, cara, dan<\/small>/);
  const anon = pollCardHtml(poll({ anonymous: true, options: poll().options.map(({ voters, ...rest }) => rest) }));
  assert.match(anon, /Anonymous/);
  assert.doesNotMatch(anon, /poll-voters|bob|cara|dan|ann/);
});

test('every value is escaped', () => {
  const html = pollCardHtml(poll({
    question: '<script>alert(1)</script>',
    options: [{ id: 1, label: '<img src=x onerror=alert(1)>', count: 1, voters: ['<b>x</b>'] }, { id: 2, label: 'a & b', count: 0, voters: [] }],
  }));
  assert.doesNotMatch(html, /<script>|<img|<b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /a &amp; b/);
});

test('a closed poll cannot be voted on, withdrawn from or closed again', () => {
  const html = pollCardHtml(poll({ closed: true }), { canClose: true });
  assert.match(html, /Closed/);
  assert.equal((html.match(/data-poll-vote="[0-9]+"[^>]*disabled/g) || []).length, 2);
  assert.doesNotMatch(html, /data-poll-withdraw|data-poll-close/);
});

test('withdraw shows only when you have voted, and close only when you may close an open poll', () => {
  assert.match(pollCardHtml(poll()), /data-poll-withdraw/);
  assert.doesNotMatch(pollCardHtml(poll({ myOptionIds: [] })), /data-poll-withdraw/);
  assert.doesNotMatch(pollCardHtml(poll(), { canClose: false }), /data-poll-close/);
  assert.match(pollCardHtml(poll(), { canClose: true }), /data-poll-close/);
});

test('multiple choice says so and carries what the client needs to toggle a choice', () => {
  const html = pollCardHtml(poll({ multiple: true, myOptionIds: [1, 2] }));
  assert.match(html, /Pick any/);
  assert.match(html, /data-poll-multiple="1"/);
  assert.match(html, /data-poll-mine="1,2"/);
});

test('an empty poll shows 0% and never divides by zero', () => {
  const html = pollCardHtml(poll({ totalVoters: 0, myOptionIds: [], options: [{ id: 1, label: 'A', count: 0, voters: [] }, { id: 2, label: 'B', count: 0, voters: [] }] }));
  assert.match(html, /0 \(0%\)/);
  assert.match(html, /style="width:0%"/);
  assert.match(html, /No votes yet/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('a closing time is shown for an open poll', () => {
  assert.match(pollCardHtml(poll({ closesAt: '2030-01-02T03:04:05.000Z' })), /Closes /);
});
