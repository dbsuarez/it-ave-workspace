const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIp, parseNetwork, ipAllowed, readDevice } = require('../src/clockRules');

test('addresses are normalized: IPv4 inside IPv6, zone ids, spaces', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.20'), '192.168.1.20');
  assert.equal(normalizeIp(' 10.0.0.5 '), '10.0.0.5');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp(undefined), '');
});

test('networks are an address or an address with a prefix; anything else is refused', () => {
  assert.deepEqual(parseNetwork('203.0.113.7'), { address: '203.0.113.7', prefix: null, family: 4 });
  assert.deepEqual(parseNetwork('192.168.1.0/24'), { address: '192.168.1.0', prefix: 24, family: 4 });
  assert.equal(parseNetwork('2001:db8::/32').family, 6);
  for (const bad of ['', 'office', '300.1.1.1', '10.0.0.0/33', '10.0.0.0/x', '10.0.0.0/8/8', '2001:db8::/129']) assert.equal(parseNetwork(bad), null, bad);
});

test('an IP is allowed when it is inside any listed network', () => {
  const offices = ['203.0.113.7', '192.168.10.0/24', '198.51.100.0/25'];
  assert.equal(ipAllowed('203.0.113.7', offices), true, 'a single address');
  assert.equal(ipAllowed('192.168.10.99', offices), true, 'inside a subnet');
  assert.equal(ipAllowed('::ffff:192.168.10.99', offices), true, 'seen as IPv6-mapped');
  assert.equal(ipAllowed('192.168.11.1', offices), false, 'next subnet over');
  assert.equal(ipAllowed('198.51.100.200', offices), false, 'outside a /25');
  assert.equal(ipAllowed('203.0.113.8', offices), false);
  assert.equal(ipAllowed('not-an-ip', offices), false);
  assert.equal(ipAllowed('10.0.0.1', []), false, 'nothing listed allows nothing');
  assert.equal(ipAllowed('2001:db8::5', ['2001:db8::/32']), true);
});

test('device headers: a sane id and a trimmed name, otherwise nothing', () => {
  assert.deepEqual(readDevice({ 'x-device-id': '3f2a9c1e-77aa-4b1e-9c2d-0123456789ab', 'x-device-name': '  OFFICE-PC (win32)  ' }), { id: '3f2a9c1e-77aa-4b1e-9c2d-0123456789ab', name: 'OFFICE-PC (win32)' });
  assert.equal(readDevice({ 'x-device-id': 'short' }).id, '', 'too short');
  assert.equal(readDevice({ 'x-device-id': 'has spaces in it ok?' }).id, '');
  assert.equal(readDevice({}).id, '');
  assert.equal(readDevice({ 'x-device-name': 'x'.repeat(300) }).name.length, 120);
});
