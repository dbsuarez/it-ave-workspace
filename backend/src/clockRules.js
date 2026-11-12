// Who may clock in from where: IP addresses and office networks, and the device a person clocks in from.
// Pure helpers (covered by test/clock-rules.test.js); routes/attendance.js decides what to do with the answers.
const net = require('net');

// "::ffff:192.168.1.20" (an IPv4 address seen by a dual-stack server) is just "192.168.1.20"; drop any zone id.
function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (ip.includes('%')) ip = ip.slice(0, ip.indexOf('%'));
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  return ip;
}

// "203.0.113.7", "203.0.113.0/24", "2001:db8::/32" -> { address, prefix | null, family } or null when it is not an address.
function parseNetwork(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const [addressText, prefixText, extra] = raw.split('/');
  if (extra !== undefined) return null;
  const address = normalizeIp(addressText);
  const family = net.isIPv4(address) ? 4 : net.isIPv6(address) ? 6 : 0;
  if (!family) return null;
  if (prefixText === undefined) return { address, prefix: null, family };
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (family === 4 ? 32 : 128)) return null;
  return { address, prefix, family };
}

// Is this IP inside any of these networks (strings as parseNetwork reads them)?
function ipAllowed(ip, networks) {
  const address = normalizeIp(ip);
  const family = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
  if (!family) return false;
  const list = new net.BlockList();
  for (const text of networks) {
    const n = parseNetwork(text);
    if (!n) continue;
    const kind = n.family === 4 ? 'ipv4' : 'ipv6';
    if (n.prefix === null) list.addAddress(n.address, kind); else list.addSubnet(n.address, n.prefix, kind);
  }
  return list.check(address, family);
}

// The device headers the app sends: a random id (made once per installation) and a readable name.
function readDevice(headers) {
  const id = String(headers['x-device-id'] || '').trim();
  const name = String(headers['x-device-name'] || '').trim().slice(0, 120);
  return { id: /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : '', name };
}

module.exports = { normalizeIp, parseNetwork, ipAllowed, readDevice };
