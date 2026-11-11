const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const NODE_ENV = process.env.NODE_ENV || 'development';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure it.');
}

if (NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required when NODE_ENV=production');
}

function getIceServers() {
  const configured = process.env.WEBRTC_ICE_SERVERS;
  if (!configured) {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  let iceServers;
  try {
    iceServers = JSON.parse(configured);
  } catch (err) {
    throw new Error('WEBRTC_ICE_SERVERS must be valid JSON', { cause: err });
  }

  if (!Array.isArray(iceServers) || iceServers.length === 0) {
    throw new Error('WEBRTC_ICE_SERVERS must be a non-empty array');
  }

  return iceServers.map((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    if (!urls.length || urls.some((url) => (
      typeof url !== 'string' || !/^(stun|stuns|turn|turns):/i.test(url)
    ))) {
      throw new Error('Each WEBRTC_ICE_SERVERS entry must have valid STUN or TURN URLs');
    }

    if (server.username !== undefined && typeof server.username !== 'string') {
      throw new Error('ICE server username must be a string');
    }
    if (server.credential !== undefined && typeof server.credential !== 'string') {
      throw new Error('ICE server credential must be a string');
    }

    return {
      urls: Array.isArray(server.urls) ? urls : urls[0],
      ...(server.username !== undefined ? { username: server.username } : {}),
      ...(server.credential !== undefined ? { credential: server.credential } : {}),
    };
  });
}

module.exports = {
  NODE_ENV,
  PORT: process.env.BACKEND_PORT || 3001,
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET || (NODE_ENV === 'production' ? null : 'dev-secret-change-me'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  SUPERADMIN_USERNAME: process.env.SUPERADMIN_USERNAME || '',
  TRUST_PROXY: process.env.TRUST_PROXY || '',
  // One access-log line per request (no bodies, no query strings). Set LOG_REQUESTS=false to silence.
  LOG_REQUESTS: String(process.env.LOG_REQUESTS || 'true').toLowerCase() !== 'false',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB || '25', 10),
  UPLOAD_DIR: process.env.UPLOAD_DIR || '/app/uploads',
  WEBRTC_ICE_SERVERS: getIceServers(),
};
