const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleMessages, sampleCanvas, SAMPLE_PEOPLE } = require('../src/viewAsDemo');

test('sample messages are fixed, obviously made up, oldest first, and never use a real id', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  const a = sampleMessages(7, 'general', now);
  const b = sampleMessages(7, 'general', now);
  assert.deepEqual(a, b, 'the same screen every time');
  assert.equal(a.length, 8);
  assert.ok(a.every((m) => m.id < 0 && m.userId < 0), 'ids can never match a real message or person');
  assert.ok(a.every((m) => SAMPLE_PEOPLE.some((p) => p.username === m.username)));
  assert.ok(a.some((m) => m.content.includes('#general')), 'names the channel');
  const times = a.map((m) => new Date(m.createdAt).getTime());
  assert.deepEqual(times, [...times].sort((x, y) => x - y), 'oldest first');
  assert.ok(times.every((t) => t < now.getTime()));
});

test('the sample canvas is read-only and says it is a sample', () => {
  const canvas = sampleCanvas(7, 'general', new Date('2026-11-12T10:00:00Z'));
  assert.equal(canvas.myRole, 'viewer');
  assert.match(canvas.title, /sample/i);
  assert.ok(canvas.id < 0);
});
