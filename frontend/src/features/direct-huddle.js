// IT Avenue Workspace - one-to-one huddles.
//
// Starting a call joins a huddle keyed to the pair of people (the server rings the other person); an
// incoming call shows a banner with Join and Decline. The call itself is the same audio, camera and
// screen-share huddle as a channel's (see renderer.js joinHuddle and features/huddleVideo.js).
//
// Loaded before renderer.js; renderer.js wires the socket events to handleHuddleInvite / ...Cancelled.

const HUDDLE_RING_SECONDS = 60;
let incomingHuddle = null;
let incomingHuddleTimer = null;

function hideHuddleInvite() {
  stopRinging();
  clearTimeout(incomingHuddleTimer);
  incomingHuddleTimer = null;
  incomingHuddle = null;
  document.getElementById('huddle-invite')?.remove();
}

function showHuddleInvite(invite) {
  document.getElementById('huddle-invite')?.remove();
  const banner = document.createElement('div');
  banner.id = 'huddle-invite';
  banner.className = 'huddle-invite';
  banner.setAttribute('role', 'alertdialog');
  banner.setAttribute('aria-label', 'Incoming huddle');
  const text = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = `${invite.from.username} is calling you`;
  const hint = document.createElement('span');
  hint.textContent = 'Join their huddle';
  text.append(name, hint);
  const actions = document.createElement('div');
  actions.className = 'huddle-invite-actions';
  const join = document.createElement('button');
  join.type = 'button';
  join.className = 'btn primary';
  join.textContent = 'Join';
  join.dataset.huddleAccept = '1';
  const decline = document.createElement('button');
  decline.type = 'button';
  decline.className = 'btn';
  decline.textContent = 'Decline';
  decline.dataset.huddleDecline = '1';
  actions.append(join, decline);
  banner.append(text, actions);
  document.body.appendChild(banner);
}

// Someone is calling this person.
function handleHuddleInvite(invite) {
  if (!invite || !invite.from || !Number.isSafeInteger(Number(invite.from.id))) return;
  if (String(state.huddle.channelId) === String(invite.key)) return; // already in that call
  incomingHuddle = invite;
  showHuddleInvite(invite);
  clearTimeout(incomingHuddleTimer);
  incomingHuddleTimer = setTimeout(hideHuddleInvite, HUDDLE_RING_SECONDS * 1000);
  // a toast, and a desktop notification when the app is in the background (not while Do Not Disturb is on)
  notifyUser('dm', `${invite.from.username} is calling you on a huddle`, undefined, { sound: false });
  startRinging(); // the ring (not a message chime) plays until answered, declined, cancelled or timed out
}

// The caller hung up before anyone answered.
function handleHuddleInviteCancelled(event) {
  if (incomingHuddle && Number(incomingHuddle.from.id) === Number(event && event.fromId)) hideHuddleInvite();
}

function huddleUsername(userId) {
  const person = (state.users || []).find((user) => Number(user.id) === Number(userId))
    || (state.dms || []).find((user) => Number(user.id) === Number(userId));
  return person ? person.username : 'them';
}

// Start (or answer) a one-to-one huddle with this person.
async function startDirectHuddle(userId, username) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) === Number(state.user.id)) return;
  if (state.huddle.channelId || state.huddle.joining) {
    showToast('Leave your current huddle first.', 'info');
    return;
  }
  hideHuddleInvite();
  await setSection('huddle');
  await joinHuddle({ userId: Number(userId), username: username || huddleUsername(userId) });
}

async function acceptHuddleInvite() {
  const invite = incomingHuddle;
  hideHuddleInvite();
  if (invite) await startDirectHuddle(invite.from.id, invite.from.username);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-huddle-accept]')) acceptHuddleInvite();
    else if (event.target.closest('[data-huddle-decline]')) hideHuddleInvite();
  });
}
