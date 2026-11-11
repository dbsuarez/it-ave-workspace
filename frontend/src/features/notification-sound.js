// IT Avenue Workspace - notification sounds.
//
// Short sounds made with the Web Audio API (no sound files): a different one for a message, a mention, a
// reply, a reaction and a reminder, and a ring that repeats while someone is calling on a huddle.
// There is a default style ("Chime") that plays out of the box; each person can pick another style and a
// volume in Preferences (kept on this computer). The "Play a sound" setting and Do Not Disturb still apply.
//
// Loaded before notifications.js; renderer code calls playNotificationSound(kind) (via notifyUser) and
// startRinging() / stopRinging() (incoming huddle calls). The pure parts are covered by tests.

const BASE_VOLUME = 0.3;
const DEFAULT_SOUND_THEME = 'chime';
const DEFAULT_SOUND_VOLUME = 70; // percent
const SOUND_GAP_MS = 700; // a burst of messages is one sound, not a machine gun
const RING_EVERY_MS = 2200;

// The sound styles a person can choose between. Each reshapes the same notes: pitch and timing scale, the
// waveform, loudness and an optional downward "pop" sweep.
const SOUND_THEMES = {
  chime: { label: 'Chime (default)', type: 'sine', pitch: 1, time: 1, length: 1, gain: 1 },
  bell: { label: 'Bell', type: 'triangle', pitch: 1.25, time: 1.3, length: 2.2, gain: 0.9 },
  marimba: { label: 'Marimba', type: 'triangle', pitch: 0.75, time: 0.9, length: 0.7, gain: 1 },
  pop: { label: 'Pop', type: 'sine', pitch: 1, time: 0.7, length: 0.6, gain: 1, sweep: 1.6 },
  soft: { label: 'Soft', type: 'sine', pitch: 0.8, time: 1.2, length: 1.4, gain: 0.7 },
  digital: { label: 'Digital', type: 'square', pitch: 1, time: 0.65, length: 0.7, gain: 0.4 },
};

// Each note: frequency (Hz), start (s), length (s), loudness (0..1).
const SOUND_PATTERNS = {
  dm: [{ f: 880, t: 0, d: 0.14, g: 1 }, { f: 1175, t: 0.15, d: 0.22, g: 1 }],
  channel: [{ f: 660, t: 0, d: 0.12, g: 0.7 }, { f: 880, t: 0.13, d: 0.18, g: 0.7 }],
  mention: [{ f: 784, t: 0, d: 0.11, g: 1 }, { f: 988, t: 0.12, d: 0.11, g: 1 }, { f: 1319, t: 0.24, d: 0.28, g: 1 }],
  reply: [{ f: 698, t: 0, d: 0.13, g: 0.9 }, { f: 932, t: 0.14, d: 0.2, g: 0.9 }],
  reaction: [{ f: 1046, t: 0, d: 0.1, g: 0.6 }],
  reminder: [{ f: 880, t: 0, d: 0.16, g: 1 }, { f: 880, t: 0.26, d: 0.16, g: 1 }, { f: 1175, t: 0.52, d: 0.34, g: 1 }],
  call: [{ f: 660, t: 0, d: 0.18, g: 1 }, { f: 880, t: 0.2, d: 0.18, g: 1 }, { f: 660, t: 0.7, d: 0.18, g: 1 }, { f: 880, t: 0.9, d: 0.18, g: 1 }],
};

function soundThemeId(id) {
  return Object.prototype.hasOwnProperty.call(SOUND_THEMES, id) ? id : DEFAULT_SOUND_THEME;
}

function soundVolumePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : DEFAULT_SOUND_VOLUME;
}

// The notes for a kind (an unknown kind gets the plain message sound), reshaped by the chosen style.
function soundPattern(kind, themeId = DEFAULT_SOUND_THEME) {
  const theme = SOUND_THEMES[soundThemeId(themeId)];
  const notes = SOUND_PATTERNS[kind] || SOUND_PATTERNS.channel;
  return notes.map((note) => ({
    f: Math.round(note.f * theme.pitch),
    t: +(note.t * theme.time).toFixed(3),
    d: +(note.d * theme.length).toFixed(3),
    g: Math.min(1, note.g * theme.gain),
    type: theme.type,
    sweep: theme.sweep || 1,
  }));
}

// Whether a sound of this kind may play now, given when the last one did.
function shouldPlaySound(kind, now, lastPlayed) {
  if (kind === 'call') return true;
  return now - (lastPlayed[kind] || 0) >= SOUND_GAP_MS;
}

let soundContext = null;
const lastSoundAt = {};
let ringTimer = null;

function soundPreferences() {
  const prefs = (typeof state !== 'undefined' && state.preferences) || {};
  return { theme: soundThemeId(prefs.soundTheme), volume: soundVolumePercent(prefs.soundVolume === undefined ? DEFAULT_SOUND_VOLUME : prefs.soundVolume) };
}

function soundsAllowed() {
  if (typeof userSettings !== 'function') return true;
  const settings = userSettings();
  return settings.notifications.sound !== false && !(typeof isDndActive === 'function' && isDndActive());
}

function audioContext() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  if (!soundContext) soundContext = new Context();
  if (soundContext.state === 'suspended') soundContext.resume().catch(() => {});
  return soundContext;
}

function scheduleNotes(context, notes, startAt, volume) {
  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = note.type;
    const begin = startAt + note.t;
    if (note.sweep && note.sweep !== 1) {
      oscillator.frequency.setValueAtTime(note.f * note.sweep, begin);
      oscillator.frequency.exponentialRampToValueAtTime(note.f, begin + Math.min(0.06, note.d));
    } else {
      oscillator.frequency.value = note.f;
    }
    gain.gain.setValueAtTime(0.0001, begin);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * note.g), begin + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, begin + note.d);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(begin);
    oscillator.stop(begin + note.d + 0.05);
  }
}

// Play the sound for a kind of notification, in the person's chosen style and volume.
// options.force plays even when sounds are off or throttled (the sample button); options.theme / .volume
// override the saved choice (so the sample can preview what is selected before it is saved).
function playNotificationSound(kind, options = {}) {
  try {
    const force = options === true || Boolean(options && options.force);
    const prefs = soundPreferences();
    const theme = options && options.theme ? soundThemeId(options.theme) : prefs.theme;
    const percent = options && options.volume !== undefined ? soundVolumePercent(options.volume) : prefs.volume;
    if (!force && (!soundsAllowed() || percent === 0)) return false;
    const now = Date.now();
    if (!force && !shouldPlaySound(kind, now, lastSoundAt)) return false;
    const context = audioContext();
    if (!context) return false;
    lastSoundAt[kind] = now;
    scheduleNotes(context, soundPattern(kind, theme), context.currentTime + 0.02, BASE_VOLUME * (percent / 100));
    return true;
  } catch (err) {
    console.warn('Notification sound failed:', err);
    return false;
  }
}

// An incoming huddle call rings until it is answered, declined, cancelled or times out.
function startRinging() {
  stopRinging();
  if (!soundsAllowed()) return;
  const ring = () => playNotificationSound('call');
  ring();
  ringTimer = setInterval(ring, RING_EVERY_MS);
}

function stopRinging() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}

// The sound choices in Preferences: a style list, a volume slider and a sample button (previews the
// selection before it is saved).
function soundPreferencesMarkup() {
  const prefs = soundPreferences();
  const options = Object.entries(SOUND_THEMES)
    .map(([id, theme]) => `<option value="${id}"${id === prefs.theme ? ' selected' : ''}>${theme.label}</option>`)
    .join('');
  return `
    <div class="form-group sound-choice">
      <label for="sound-theme">Notification sound</label>
      <select id="sound-theme">${options}</select>
    </div>
    <div class="form-group sound-choice">
      <label for="sound-volume">Volume</label>
      <div class="sound-volume-row">
        <input id="sound-volume" type="range" min="0" max="100" step="5" value="${prefs.volume}">
        <button type="button" class="btn" id="btn-sound-sample">Play sample</button>
      </div>
    </div>`;
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    if (!(event.target.closest && event.target.closest('#btn-sound-sample'))) return;
    playNotificationSound('mention', {
      force: true,
      theme: document.getElementById('sound-theme')?.value,
      volume: document.getElementById('sound-volume')?.value,
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SOUND_PATTERNS, SOUND_THEMES, DEFAULT_SOUND_THEME, DEFAULT_SOUND_VOLUME, soundPattern, soundThemeId, soundVolumePercent, shouldPlaySound, SOUND_GAP_MS,
  };
}
