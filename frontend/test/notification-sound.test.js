const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SOUND_PATTERNS, SOUND_THEMES, DEFAULT_SOUND_THEME, DEFAULT_SOUND_VOLUME, soundPattern, soundThemeId, soundVolumePercent, shouldPlaySound, SOUND_GAP_MS,
} = require('../src/features/notification-sound');

const KINDS = ['dm', 'channel', 'mention', 'reply', 'reaction', 'reminder', 'call'];

test('there is a default sound, and it is a real choice in the list', () => {
  assert.equal(DEFAULT_SOUND_THEME, 'chime');
  assert.ok(SOUND_THEMES[DEFAULT_SOUND_THEME]);
  assert.match(SOUND_THEMES[DEFAULT_SOUND_THEME].label, /default/i, 'it says which one is the default');
  assert.equal(DEFAULT_SOUND_VOLUME, 70);
  assert.equal(soundThemeId(undefined), 'chime');
  assert.equal(soundThemeId('nonsense'), 'chime', 'an unknown or stale choice falls back to the default');
  assert.equal(soundThemeId('bell'), 'bell');
  assert.equal(soundThemeId('__proto__'), 'chime');
});

test('volume is a whole percent between 0 and 100', () => {
  assert.equal(soundVolumePercent(40), 40);
  assert.equal(soundVolumePercent('55'), 55);
  assert.equal(soundVolumePercent(-5), 0);
  assert.equal(soundVolumePercent(500), 100);
  assert.equal(soundVolumePercent('loud'), DEFAULT_SOUND_VOLUME);
  assert.equal(soundVolumePercent(undefined), DEFAULT_SOUND_VOLUME);
});

test('every style gives every kind of notification a short, audible sound', () => {
  for (const theme of Object.keys(SOUND_THEMES)) {
    for (const kind of KINDS) {
      const notes = soundPattern(kind, theme);
      assert.ok(notes.length >= 1, `${theme}/${kind}`);
      for (const note of notes) {
        assert.ok(note.f >= 300 && note.f <= 2600, `${theme}/${kind}: ${note.f}Hz is a comfortable pitch`);
        assert.ok(note.d > 0.04 && note.d < 1.4, `${theme}/${kind}: note length ${note.d}`);
        assert.ok(note.t >= 0 && note.g > 0 && note.g <= 1);
        assert.ok(['sine', 'triangle', 'square'].includes(note.type));
      }
      const length = Math.max(...notes.map((n) => n.t + n.d));
      assert.ok(length <= (kind === 'call' ? 2.4 : 1.8), `${theme}/${kind} is ${length}s: short enough not to annoy`);
    }
  }
});

test('the styles sound different, and so do the kinds within a style', () => {
  const signature = (kind, theme) => JSON.stringify(soundPattern(kind, theme).map((n) => [n.f, n.t, n.d, n.type]));
  assert.equal(new Set(Object.keys(SOUND_THEMES).map((theme) => signature('mention', theme))).size, Object.keys(SOUND_THEMES).length);
  for (const theme of Object.keys(SOUND_THEMES)) {
    assert.equal(new Set(KINDS.map((kind) => signature(kind, theme))).size, KINDS.length, theme);
  }
  assert.ok(soundPattern('mention').length > soundPattern('dm').length, 'a mention is the most insistent');
  assert.equal(soundPattern('nonsense')[0].f, soundPattern('channel')[0].f, 'an unknown kind gets the plain message sound');
  assert.equal(soundPattern('dm')[0].f, SOUND_PATTERNS.dm[0].f, 'the default style plays the base notes unchanged');
});

test('a burst of messages makes one sound, but a ring is never held back', () => {
  const last = {};
  assert.equal(shouldPlaySound('dm', 10000, last), true);
  last.dm = 10000;
  assert.equal(shouldPlaySound('dm', 10000 + SOUND_GAP_MS - 1, last), false);
  assert.equal(shouldPlaySound('dm', 10000 + SOUND_GAP_MS, last), true);
  assert.equal(shouldPlaySound('mention', 10100, last), true, 'kinds are throttled separately');
  last.call = 10000;
  assert.equal(shouldPlaySound('call', 10001, last), true);
});
