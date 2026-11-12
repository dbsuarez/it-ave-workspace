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

test('the private screens have fixed samples with fake ids, and never real content', () => {
  const { sampleDirectMessages, sampleConversation, sampleNotes, sampleSaved, sampleFiles, sampleActivity } = require('../src/viewAsDemo');
  const now = new Date('2026-11-12T10:00:00Z');
  const dm = sampleDirectMessages(5, 9, now);
  assert.deepEqual(dm, sampleDirectMessages(5, 9, now));
  assert.ok(dm.every((m) => m.id < 0));
  assert.ok(dm.some((m) => m.senderId === 5) && dm.some((m) => m.senderId === 9), 'both sides of the conversation');
  assert.ok(sampleConversation(now).id < 0);
  assert.ok(sampleNotes(now).every((n) => n.id < 0 && /sample/i.test(n.title)));
  const channel = { id: 3, name: 'general' };
  assert.ok(sampleSaved(channel, now).every((i) => i.id < 0));
  assert.ok(sampleFiles(channel, now).every((f) => f.id < 0 && /sample/i.test(f.name)));
  assert.ok(sampleActivity(channel, now).items.every((i) => i.messageId < 0));
});

test('the sample timesheet is worked out by the real rules from made-up punches', () => {
  const { sampleTimesheet, sampleLeave } = require('../src/viewAsDemo');
  const sheet = sampleTimesheet(5, '2026-10-01', '2026-10-31', '2026-11-12');
  assert.deepEqual(sheet, sampleTimesheet(5, '2026-10-01', '2026-10-31', '2026-11-12'), 'fixed');
  assert.equal(sheet.days.length, 31);
  assert.ok(sheet.totals.presentDays >= 15 && sheet.totals.lateCount === 1 && sheet.totals.lateMinutes === 25, JSON.stringify(sheet.totals));
  assert.ok(sheet.days.some((d) => d.status === 'leave'));
  assert.ok(sheet.days.filter((d) => d.status === 'rest').length >= 8, 'weekends');
  assert.ok(sheet.days.every((d) => d.punches.every((p) => !p.inIp)), 'no addresses');
  const future = sampleTimesheet(5, '2026-12-01', '2026-12-31', '2026-11-12');
  assert.ok(future.days.every((d) => d.status === 'upcoming' || d.status === 'rest' || d.status === 'leave'), 'nothing worked in the future');
  const leave = sampleLeave(2026);
  assert.ok(leave.balances.every((b) => b.typeId < 0));
});
