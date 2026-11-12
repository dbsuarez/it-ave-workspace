const test = require('node:test');
const assert = require('node:assert/strict');
const { planUpload, MAX_FILES_PER_MESSAGE } = require('../src/features/attachments');

test('up to ten files go in one message; the rest are counted as left out', () => {
  const files = Array.from({ length: 13 }, (_, i) => ({ name: `f${i}.png` }));
  const plan = planUpload(files);
  assert.equal(MAX_FILES_PER_MESSAGE, 10);
  assert.equal(plan.files.length, 10);
  assert.equal(plan.skipped, 3);
  assert.equal(plan.files[0].name, 'f0.png', 'the order they were chosen in');
});

test('few files are all kept, and nothing is fine', () => {
  assert.deepEqual(planUpload([{ name: 'a' }, { name: 'b' }]), { files: [{ name: 'a' }, { name: 'b' }], skipped: 0 });
  assert.deepEqual(planUpload([]), { files: [], skipped: 0 });
  assert.deepEqual(planUpload(null), { files: [], skipped: 0 });
});
