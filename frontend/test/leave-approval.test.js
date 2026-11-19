const test = require('node:test');
const assert = require('node:assert/strict');
const { leaveApprovalFactsHtml } = require('../src/features/leave-approval');

const fmt = { range: (r) => `${r.startDate}..${r.endDate}`, days: (n) => `${n} ${n === 1 ? 'day' : 'days'}` };
const request = (extra = {}) => ({
  balances: [{ name: 'Vacation Leave', entitled: 15, remaining: 12 }, { name: 'Sick Leave', entitled: 10, remaining: 8.5 }],
  lastLeave: { typeName: 'Sick Leave', startDate: '2026-11-02', endDate: '2026-11-03', days: 2 },
  ...extra,
});

test('the card says what is left of each type and the last leave taken', () => {
  const html = leaveApprovalFactsHtml(request(), fmt);
  assert.match(html, /Vacation Leave/);
  assert.match(html, /12 left of 15/);
  assert.match(html, /Sick Leave/);
  assert.match(html, /8\.5 left of 10/);
  assert.match(html, /Last leave/);
  assert.match(html, /Sick Leave.*2026-11-02\.\.2026-11-03.*2 days/);
});

test('someone who has taken no leave yet says so, and types without an allowance are not shown', () => {
  assert.match(leaveApprovalFactsHtml(request({ lastLeave: null }), fmt), /No leave taken yet/);
  const html = leaveApprovalFactsHtml(request({ balances: [] }), fmt);
  assert.equal(/left of/.test(html), false);
  assert.match(html, /Last leave/);
});

test('a card from a server that sends neither shows nothing extra; names are escaped', () => {
  assert.equal(leaveApprovalFactsHtml({}, fmt), '');
  const html = leaveApprovalFactsHtml(request({ balances: [{ name: '<b>x</b>', entitled: 1, remaining: 1 }] }), fmt);
  assert.equal(html.includes('<b>x</b>'), false);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});
