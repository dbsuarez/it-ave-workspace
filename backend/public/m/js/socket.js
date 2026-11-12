// The live connection (new messages, leave and attendance news). One socket, with a tiny event bus the screens use.
import { session } from './api.js';

let socket = null;
let ready = false;
const listeners = new Map(); // event -> Set(fn)
const statusListeners = new Set();

const EVENTS = ['new_message', 'new_direct_message', 'new_group_message', 'message_sent', 'message_error', 'channel_activity', 'activity',
  'leave_updated', 'attendance_updated', 'message_deleted', 'message_updated', 'account_updated', 'channel_access_revoked', 'user_status_updated'];

function fire(event, payload) {
  (listeners.get(event) || []).forEach((fn) => { try { fn(payload); } catch (err) { console.error(err); } });
}

function setReady(value) {
  ready = value;
  statusListeners.forEach((fn) => fn(value));
}

export function connect() {
  if (socket || typeof io !== 'function' || !session.token) return;
  socket = io({ auth: { token: session.token }, transports: ['websocket', 'polling'] });
  socket.on('connect', () => socket.emit('authenticate', session.token));
  socket.on('authenticated', () => setReady(true));
  socket.on('disconnect', () => setReady(false));
  EVENTS.forEach((event) => socket.on(event, (payload) => fire(event, payload)));
}

export function disconnect() {
  if (socket) socket.disconnect();
  socket = null;
  setReady(false);
}

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function onStatus(fn) {
  statusListeners.add(fn);
  fn(ready);
  return () => statusListeners.delete(fn);
}

export function emit(event, payload) {
  if (socket) socket.emit(event, payload);
}

export const isReady = () => ready;
