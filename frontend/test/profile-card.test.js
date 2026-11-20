// The small profile card: markup and where it opens. Pure: data in, HTML or numbers out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { profileCardHtml, profileCardPosition } = require('../src/features/profile-card');

const card = { id: 7, username: 'dante.suarez', firstName: 'Dante', lastName: 'Suarez', avatarColor: '#7c3aed', status: 'online', statusText: 'In a <b>meeting</b>', statusEmoji: '📅',
  jobTitle: 'Developer', department: 'MIS', location: 'Makati', managerName: 'Bea Cruz', sharedChannels: 3 };

test('the card shows the full name large, the username small, the job title, status, shared channels and the chips', () => {
  const html = profileCardHtml({ card, name: 'Dante Suarez', isSelf: false });
  assert.match(html, /<h3[^>]*>Dante Suarez<\/h3>/);
  assert.match(html, /@dante\.suarez/);
  assert.match(html, /Developer/);
  assert.match(html, /3 shared channels/);
  assert.match(html, /MIS/);
  assert.match(html, /Makati/);
  assert.match(html, /Reports to Bea Cruz/);
  assert.match(html, /class="[^"]*pcard2-dot online/);
  assert.match(html, /background:\s*linear-gradient\([^)]*#7c3aed/, 'the banner uses their colour');
  assert.match(html, /data-avatar-user="7"/, 'the photo is painted by the app\'s own avatar code');
});

test('everything printed is escaped, and no role names or contact details are printed', () => {
  const html = profileCardHtml({ card, name: 'Dante <script>', isSelf: false });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /In a &lt;b&gt;meeting&lt;\/b&gt;/);
  assert.equal(/Admin|Owner|Moderator|@x\.test|email|phone/i.test(html), false);
});

test('someone else\'s card has a message box, a call and a more menu; your own has Edit profile instead', () => {
  const other = profileCardHtml({ card, name: 'Dante Suarez', isSelf: false });
  assert.match(other, /<input[^>]*data-pcard-message[^>]*placeholder="Message Dante Suarez"/);
  assert.match(other, /data-pcard-huddle[^>]*title="[^"]*[Cc]all/);
  assert.match(other, /data-pcard-more/);
  assert.match(other, /data-pcard-page/);
  assert.doesNotMatch(other, /data-pcard-edit/);
  const self = profileCardHtml({ card: { ...card, sharedChannels: null }, name: 'Dante Suarez', isSelf: true });
  assert.match(self, /data-pcard-edit/);
  assert.doesNotMatch(self, /data-pcard-message|data-pcard-huddle/);
  assert.doesNotMatch(self, /shared channel/);
});

test('missing details leave no empty chips or labels', () => {
  const html = profileCardHtml({ card: { id: 9, username: 'sam', firstName: '', lastName: '', avatarColor: null, status: 'offline', statusText: '', statusEmoji: '', jobTitle: '', department: '', location: '', managerName: '', sharedChannels: 1 }, name: 'sam', isSelf: false });
  assert.match(html, /1 shared channel(?!s)/);
  assert.equal(/pcard2-chip/.test(html), false);
  assert.equal(/Reports to/.test(html), false);
  assert.equal(/pcard2-status-text/.test(html), false);
  assert.match(html, /pcard2-dot offline/);
});

test('the card opens beside the name or picture that was clicked, and always stays on the screen', () => {
  const view = { vw: 1200, vh: 800, width: 320, height: 380 };
  // room on the right: it opens there, level with the top of what was clicked
  assert.deepEqual(profileCardPosition({ anchor: { left: 100, top: 200, right: 140, bottom: 240 }, ...view }), { left: 150, top: 200 });
  // no room on the right: it opens on the left
  assert.deepEqual(profileCardPosition({ anchor: { left: 1000, top: 200, right: 1100, bottom: 240 }, ...view }), { left: 670, top: 200 });
  // near the bottom it is moved up so it is not cut off
  assert.equal(profileCardPosition({ anchor: { left: 100, top: 700, right: 140, bottom: 740 }, ...view }).top, 800 - 380 - 12);
  // never above the top or off the left
  const small = profileCardPosition({ anchor: { left: 2, top: 2, right: 8, bottom: 8 }, vw: 300, vh: 300, width: 320, height: 380 });
  assert.equal(small.left >= 0 && small.top >= 0, true);
});
