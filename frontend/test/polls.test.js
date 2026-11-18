const test = require('node:test');
const assert = require('node:assert/strict');
const { pollCardHtml, pollDialogHtml, pollDraftValid, pollDraftRequest, POLL_CLOSE_CHOICES } = require('../src/features/polls');

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

const closedPoll = (extra = {}) => poll({
  closed: true,
  options: [
    { id: 1, label: 'Pizza', count: 1, voters: ['ann'], voterIds: [11] },
    { id: 2, label: 'Sushi', count: 3, voters: ['bob', 'cara', 'dan'], voterIds: [12, 13, 14] },
  ],
  ...extra,
});
const people = (id) => ({ 11: { name: 'Ann Lee', avatarColor: '#112233' }, 12: { name: 'Bob Ray', avatarColor: '#445566' } }[id] || null);

test('in a closed poll the voters are small round avatars, not a line of names', () => {
  const html = pollCardHtml(closedPoll(), { people });
  assert.doesNotMatch(html, /poll-voters/);
  assert.equal((html.match(/class="read-receipt-avatar"/g) || []).length, 4);
  assert.match(html, /data-user-id="12"/);
  assert.match(html, /title="Bob Ray"/);
  assert.match(html, /style="background:#445566;"/);
  assert.match(html, />B<\/span>/);
});

test('a voter the client does not know yet still gets an avatar, named by username, on the default colour', () => {
  const html = pollCardHtml(closedPoll(), { people });
  assert.match(html, /data-user-id="13"[^>]*>C<\/span>/);
  assert.match(html, /title="cara"/);
  assert.match(html, /background:#A855F7/);
});

test('only the first few avatars show, and the rest are counted', () => {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const html = pollCardHtml(closedPoll({ options: [{ id: 1, label: 'A', count: 10, voters: ids.map((n) => `u${n}`), voterIds: ids }, { id: 2, label: 'B', count: 0, voters: [], voterIds: [] }] }));
  assert.equal((html.match(/class="read-receipt-avatar"/g) || []).length, 6);
  assert.match(html, /\+4/);
});

test('an open poll still lists names, and a closed anonymous poll shows no avatars', () => {
  assert.match(pollCardHtml(poll(), { people }), /poll-voters/);
  const anon = pollCardHtml(closedPoll({ anonymous: true, options: closedPoll().options.map(({ voters, voterIds, ...rest }) => rest) }), { people });
  assert.doesNotMatch(anon, /read-receipt-avatar|poll-voters/);
});

test('a closed poll from a server that sends no ids falls back to the names', () => {
  const html = pollCardHtml(poll({ closed: true }), { people });
  assert.match(html, /poll-voters/);
});

test('avatar names are escaped', () => {
  const html = pollCardHtml(closedPoll(), { people: () => ({ name: '"><img src=x>', avatarColor: '#000000' }) });
  assert.doesNotMatch(html, /<img/);
});

test('the card has no line breaks or indentation between its tags, because chat text keeps them as blank lines (that made polls tall)', () => {
  for (const html of [pollCardHtml(poll()), pollCardHtml(poll({ closed: true })), pollCardHtml(poll({ totalVoters: 0, myOptionIds: [] }))]) {
    assert.doesNotMatch(html, /\n/);
    assert.doesNotMatch(html, />\s+</);
  }
});

const draft = (extra = {}) => ({ question: 'Lunch?', options: ['Pizza', 'Sushi'], multiple: false, anonymous: false, closes: '', ...extra });

test('the create-poll dialog has a question box, two option boxes to start, switches, an end time and a Create button', () => {
  const html = pollDialogHtml(draft());
  assert.match(html, /data-poll-question/);
  assert.equal((html.match(/data-poll-option="/g) || []).length, 2);
  assert.match(html, /data-poll-add-option/);
  assert.match(html, /data-poll-multiple/);
  assert.match(html, /data-poll-anonymous/);
  assert.match(html, /data-poll-closes/);
  assert.match(html, /data-poll-create(?![-\w])/);
  assert.match(html, /Create poll/);
});

test('more options can be added up to ten, and extra ones can be removed but never below two', () => {
  const three = pollDialogHtml(draft({ options: ['a', 'b', 'c'] }));
  assert.equal((three.match(/data-poll-remove-option="/g) || []).length, 3);
  assert.equal((pollDialogHtml(draft()).match(/data-poll-remove-option="/g) || []).length, 0);
  const ten = pollDialogHtml(draft({ options: Array.from({ length: 10 }, (_, i) => `o${i}`) }));
  assert.doesNotMatch(ten, /data-poll-add-option/);
});

test('the Create button is off until there is a question and two real options, and the dialog shows what was typed, escaped', () => {
  assert.match(pollDialogHtml(draft({ question: '' })), /data-poll-create[^>]*disabled/);
  assert.match(pollDialogHtml(draft({ options: ['only', ''] })), /data-poll-create[^>]*disabled/);
  assert.doesNotMatch(pollDialogHtml(draft()), /data-poll-create[^>]*disabled/);
  const html = pollDialogHtml(draft({ question: '"><script>x</script>', options: ['<b>a</b>', 'b'], multiple: true, anonymous: true, closes: '1d' }));
  assert.doesNotMatch(html, /<script>|<b>/);
  assert.match(html, /data-poll-multiple[^>]*checked/);
  assert.match(html, /data-poll-anonymous[^>]*checked/);
  assert.match(html, /<option value="1d" selected>/);
});

test('a draft is valid with a question up to 200 characters and 2 to 10 options of up to 100, blank boxes ignored', () => {
  assert.equal(pollDraftValid(draft()), true);
  assert.equal(pollDraftValid(draft({ options: ['a', '', '  ', 'b'] })), true, 'blank boxes do not count');
  assert.equal(pollDraftValid(draft({ options: ['a', ' '] })), false);
  assert.equal(pollDraftValid(draft({ question: ' ' })), false);
  assert.equal(pollDraftValid(draft({ question: 'x'.repeat(201) })), false);
  assert.equal(pollDraftValid(draft({ options: ['a', 'x'.repeat(101)] })), false);
  assert.equal(pollDraftValid(draft({ options: Array.from({ length: 11 }, (_, i) => `o${i}`) })), false);
});

test('the request sent to the server is trimmed, drops blank boxes and carries the switches and the end time', () => {
  assert.deepEqual(pollDraftRequest(draft({ question: '  Lunch?  ', options: [' Pizza ', '', 'Sushi'], multiple: true, anonymous: true, closes: '1h' }), 12),
    { channelId: 12, question: 'Lunch?', options: ['Pizza', 'Sushi'], multiple: true, anonymous: true, closes: '1h' });
  assert.equal('closes' in pollDraftRequest(draft(), 3), false, 'no end time is left out');
});

test('the end-time choices start with never and all fit what the server accepts', () => {
  assert.equal(POLL_CLOSE_CHOICES[0].value, '');
  for (const choice of POLL_CLOSE_CHOICES.slice(1)) assert.match(choice.value, /^\d{1,4}[mhd]$/);
});
