const test = require('node:test');
const assert = require('node:assert/strict');
const { announcementDialogHtml, announcementDraftValid, announcementCounterText, ANNOUNCEMENT_MAX } = require('../src/features/announcements');

test('an announcement needs some text and at most 2000 characters', () => {
  assert.equal(ANNOUNCEMENT_MAX, 2000);
  assert.equal(announcementDraftValid('Office closed Friday'), true);
  assert.equal(announcementDraftValid(''), false);
  assert.equal(announcementDraftValid('  \n  '), false);
  assert.equal(announcementDraftValid('x'.repeat(2000)), true);
  assert.equal(announcementDraftValid('x'.repeat(2001)), false);
  assert.equal(announcementDraftValid(undefined), false);
});

test('the counter shows how much of the limit is used', () => {
  assert.equal(announcementCounterText(''), '0 / 2000');
  assert.equal(announcementCounterText('hello'), '5 / 2000');
});

test('the dialog says where it posts, has a text box, a counter, a preview of how it will look, and a Post button', () => {
  const html = announcementDialogHtml({ text: '', channelName: 'announcements' });
  assert.match(html, /<h3>Post announcement<\/h3>/);
  assert.match(html, /#announcements/);
  assert.match(html, /<textarea[^>]*data-announce-text[^>]*maxlength="2000"/);
  assert.match(html, /data-announce-count/);
  assert.match(html, /data-announce-preview/);
  assert.match(html, /Announcement<\/span>/);
  assert.match(html, /data-announce-cancel/);
  assert.match(html, /data-announce-post/);
});

test('the Post button is off until there is text, and what was typed shows in the box and the preview, escaped', () => {
  assert.match(announcementDialogHtml({ text: '', channelName: 'a' }), /data-announce-post[^>]*disabled/);
  assert.match(announcementDialogHtml({ text: '   ', channelName: 'a' }), /data-announce-post[^>]*disabled/);
  const html = announcementDialogHtml({ text: '<script>x</script> & "co"', channelName: '<b>n</b>' });
  assert.doesNotMatch(html, /data-announce-post[^>]*disabled/);
  assert.doesNotMatch(html, /<script>|<b>n/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt; &amp; &quot;co&quot;/);
  assert.match(html, /25 \/ 2000/);
});
