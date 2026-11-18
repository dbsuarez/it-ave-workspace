const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand } = require('../src/commands/parser');

const flags = () => ({ multi: false, anonymous: false, closes: true });
const status400 = (fn, pattern) => assert.throws(fn, (error) => {
  assert.equal(error.status, 400);
  if (pattern) assert.match(error.message, pattern);
  return true;
});

test('plain commands keep their shape: name, positional args, empty options', () => {
  assert.deepEqual(parseCommand('/leave-remaining sick'), { name: 'leave-remaining', args: ['sick'], options: {} });
  assert.deepEqual(parseCommand('  /HELP  '), { name: 'help', args: [], options: {} });
});

test('double quotes group words and keep inner spaces', () => {
  const parsed = parseCommand('/poll "Lunch on Friday?" "Pizza" "Sushi and ramen"');
  assert.equal(parsed.name, 'poll');
  assert.deepEqual(parsed.args, ['Lunch on Friday?', 'Pizza', 'Sushi and ramen']);
});

test('a backslash-escaped quote stays inside the argument', () => {
  assert.deepEqual(parseCommand('/poll "Say \\"hi\\"?" "yes"').args, ['Say "hi"?', 'yes']);
});

test('flags with and without values land in options, not args', () => {
  const parsed = parseCommand('/poll "Q?" "A" "B" --multi --closes 2h', { flagsFor: flags });
  assert.deepEqual(parsed.args, ['Q?', 'A', 'B']);
  assert.deepEqual(parsed.options, { multi: true, closes: '2h' });
  assert.deepEqual(parseCommand('/poll "Q?" "A" "B" --closes=30m', { flagsFor: flags }).options, { closes: '30m' });
});

test('an unknown flag is refused, and so is any flag when the command declares none', () => {
  status400(() => parseCommand('/poll "Q?" "A" "B" --nope', { flagsFor: flags }), /--nope/);
  status400(() => parseCommand('/help --multi'), /--multi/);
});

test('a flag that needs a value but has none is refused', () => {
  status400(() => parseCommand('/poll "Q?" "A" "B" --closes', { flagsFor: flags }), /closes/);
  status400(() => parseCommand('/poll "Q?" "A" "B" --closes --multi', { flagsFor: flags }), /closes/);
});

test('an unbalanced quote is refused with a message that mentions the quote', () => {
  status400(() => parseCommand('/poll "Lunch?'), /quote/i);
});

test('an empty quoted argument is refused', () => {
  status400(() => parseCommand('/poll ""'), /empty/i);
});

test('emoji and non-ASCII text survive untouched', () => {
  assert.deepEqual(parseCommand('/poll "Café ☕?" "👍" "日本語"').args, ['Café ☕?', '👍', '日本語']);
});

test('length is capped at 300 by default and at the per-command maxLength when given', () => {
  status400(() => parseCommand('/x ' + 'a'.repeat(300)), /300/);
  assert.equal(parseCommand('/announce ' + 'a'.repeat(1990), { maxLength: 2000 }).args[0].length, 1990);
  status400(() => parseCommand('/announce ' + 'a'.repeat(2000), { maxLength: 2000 }), /2000/);
});

test('input that is not text, does not start with a slash, or has no name is refused', () => {
  status400(() => parseCommand(42), /text/);
  status400(() => parseCommand('hello'), /start with/);
  status400(() => parseCommand('/   '), /Choose/);
});
