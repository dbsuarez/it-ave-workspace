// IT Avenue Workspace - camera video and screen sharing in a Huddle.
//
// Every peer connection carries one video slot (a transceiver negotiated up
// front), so turning the camera or a screen share on and off is a track swap
// with no renegotiation. One video source at a time per person: starting a
// screen share replaces the camera, and the other way round.
//
// Loaded before renderer.js; defines functions only.

function huddleVideoState() {
  if (!state.huddle.video) state.huddle.video = { mode: null, track: null, remote: new Map() };
  return state.huddle.video;
}

// Called from createHuddlePeer on the side that sends the offer.
function attachHuddleVideo(peer, isOfferer) {
  if (!isOfferer) return;
  const transceiver = peer.connection.addTransceiver('video', { direction: 'sendrecv' });
  peer.videoSender = transceiver.sender;
  const track = huddleVideoState().track;
  if (track) transceiver.sender.replaceTrack(track).catch((err) => console.error('Attach huddle video error:', err));
}

// Called on the answering side after the offer is applied, before the answer.
async function prepareHuddleVideoAnswer(peer) {
  const transceiver = peer.connection.getTransceivers()
    .find((item) => item.receiver?.track?.kind === 'video');
  if (!transceiver) return;
  transceiver.direction = 'sendrecv';
  peer.videoSender = transceiver.sender;
  const track = huddleVideoState().track;
  if (track) await transceiver.sender.replaceTrack(track);
}

function huddleVideoTile(key, label) {
  const grid = document.getElementById('huddle-videos');
  let tile = grid.querySelector(`[data-video-key="${CSS.escape(key)}"]`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'huddle-video-tile';
    tile.dataset.videoKey = key;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    const caption = document.createElement('span');
    caption.className = 'huddle-video-label';
    tile.append(video, caption);
    grid.appendChild(tile);
  }
  tile.querySelector('.huddle-video-label').textContent = label;
  grid.hidden = false;
  return tile;
}

function removeHuddleVideoTile(key) {
  const grid = document.getElementById('huddle-videos');
  if (!grid) return;
  grid.querySelector(`[data-video-key="${CSS.escape(key)}"]`)?.remove();
  grid.hidden = grid.children.length === 0;
}

// Remote video track arrived (at negotiation). It is shown only while the
// other person says their camera or screen is on.
function handleRemoteHuddleVideo(peer, track) {
  peer.videoTrack = track;
  refreshRemoteHuddleVideo(peer.participant.peerId);
}

function refreshRemoteHuddleVideo(peerId) {
  const peer = state.huddle.peers.get(peerId);
  const mode = huddleVideoState().remote.get(peerId) || null;
  if (!peer || !peer.videoTrack || !mode) {
    removeHuddleVideoTile(`peer-${peerId}`);
    return;
  }
  const name = peer.participant.username || 'Workspace member';
  const tile = huddleVideoTile(`peer-${peerId}`, mode === 'screen' ? `${name}'s screen` : name);
  tile.classList.toggle('screen', mode === 'screen');
  const video = tile.querySelector('video');
  if (!video.srcObject || video.srcObject.getVideoTracks()[0] !== peer.videoTrack) {
    video.srcObject = new MediaStream([peer.videoTrack]);
  }
  video.play().catch(() => {});
}

function handleHuddleMediaState({ peerId, video }) {
  const remote = huddleVideoState().remote;
  if (video) remote.set(peerId, video); else remote.delete(peerId);
  refreshRemoteHuddleVideo(peerId);
}

function announceHuddleVideoState() {
  if (state.socket?.connected && state.huddle.channelId) {
    state.socket.emit('huddle:media-state', { video: huddleVideoState().mode });
  }
}

async function setLocalHuddleVideo(mode, track) {
  const video = huddleVideoState();
  if (video.track && video.track !== track) {
    video.track.onended = null;
    video.track.stop();
  }
  video.mode = mode;
  video.track = track;
  for (const peer of state.huddle.peers.values()) {
    if (peer.videoSender) {
      await peer.videoSender.replaceTrack(track).catch((err) => console.error('Swap huddle video error:', err));
    }
  }
  if (track) {
    const tile = huddleVideoTile('local', mode === 'screen' ? 'Your screen' : 'You');
    tile.classList.toggle('screen', mode === 'screen');
    tile.classList.add('local');
    tile.querySelector('video').srcObject = new MediaStream([track]);
  } else {
    removeHuddleVideoTile('local');
  }
  announceHuddleVideoState();
  updateHuddleVideoControls();
}

async function toggleHuddleCamera() {
  if (!state.huddle.channelId) return;
  if (huddleVideoState().mode === 'camera') { await setLocalHuddleVideo(null, null); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const track = stream.getVideoTracks()[0];
    track.onended = () => { if (huddleVideoState().track === track) setLocalHuddleVideo(null, null); };
    await setLocalHuddleVideo('camera', track);
  } catch (err) {
    console.error('Start camera error:', err);
    showToast('Could not start the camera. Check that one is connected and not in use.', 'error');
  }
}

async function toggleHuddleScreen() {
  if (!state.huddle.channelId) return;
  if (huddleVideoState().mode === 'screen') { await setLocalHuddleVideo(null, null); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    track.onended = () => { if (huddleVideoState().track === track) setLocalHuddleVideo(null, null); };
    await setLocalHuddleVideo('screen', track);
  } catch (err) {
    console.error('Start screen share error:', err);
    showToast('Could not share the screen.', 'error');
  }
}

// Called when a peer leaves and when the whole huddle is torn down.
function removeHuddleVideo(peerId) {
  huddleVideoState().remote.delete(peerId);
  removeHuddleVideoTile(`peer-${peerId}`);
}

function stopLocalHuddleVideo() {
  const video = huddleVideoState();
  if (video.track) {
    video.track.onended = null;
    video.track.stop();
  }
  video.mode = null;
  video.track = null;
  video.remote.clear();
  const grid = document.getElementById('huddle-videos');
  if (grid) { grid.replaceChildren(); grid.hidden = true; }
  updateHuddleVideoControls();
}

function updateHuddleVideoControls() {
  const inCall = Boolean(state.huddle.channelId && state.huddle.localStream);
  const mode = huddleVideoState().mode;
  const camera = document.getElementById('btn-huddle-camera');
  const screen = document.getElementById('btn-huddle-screen');
  if (camera) {
    camera.disabled = !inCall;
    camera.classList.toggle('active', mode === 'camera');
    camera.setAttribute('aria-label', mode === 'camera' ? 'Turn camera off' : 'Turn camera on');
    camera.title = camera.getAttribute('aria-label');
  }
  if (screen) {
    screen.disabled = !inCall;
    screen.classList.toggle('active', mode === 'screen');
    screen.setAttribute('aria-label', mode === 'screen' ? 'Stop sharing your screen' : 'Share your screen');
    screen.title = screen.getAttribute('aria-label');
  }
}

function setupHuddleVideoFeatures() {
  document.getElementById('btn-huddle-camera')?.addEventListener('click', toggleHuddleCamera);
  document.getElementById('btn-huddle-screen')?.addEventListener('click', toggleHuddleScreen);
}
