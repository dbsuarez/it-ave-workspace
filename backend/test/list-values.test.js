const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCellValue, normalizeColumnOptions, validateColumnName, keyFromName } = require('../src/listValues');

const col = (type, extra = {}) => ({ id: 1, name: 'Col', type, options: {}, is_primary: false, ...extra });
const rejects = (column, value, pattern, ctx) => assert.rejects(
  () => normalizeCellValue(column, value, ctx),
  (err) => err.status === 400 && pattern.test(err.message)
);

test('empty values clear a cell, except in the primary column', async () => {
  for (const empty of [null, undefined, '', []]) {
    assert.equal(await normalizeCellValue(col('text'), empty), null);
  }
  await rejects(col('text', { is_primary: true, name: 'Name' }), '', /cannot be empty/);
  await rejects(col('text', { is_primary: true, name: 'Name' }), '   ', /cannot be empty/);
});

test('text is trimmed and limited (shorter for the primary column)', async () => {
  assert.equal(await normalizeCellValue(col('text'), '  hello '), 'hello');
  assert.equal(await normalizeCellValue(col('text'), 'x'.repeat(2000)), 'x'.repeat(2000));
  await rejects(col('text'), 'x'.repeat(2001), /at most 2000/);
  await rejects(col('text', { is_primary: true }), 'x'.repeat(201), /at most 200/);
  await rejects(col('text'), 42, /must be text/);
});

test('checkbox only accepts booleans', async () => {
  assert.equal(await normalizeCellValue(col('checkbox'), true), true);
  assert.equal(await normalizeCellValue(col('checkbox'), false), false);
  await rejects(col('checkbox'), 'true', /true or false/);
  await rejects(col('checkbox'), 1, /true or false/);
});

test('dates must be real calendar days', async () => {
  assert.equal(await normalizeCellValue(col('date'), '2026-02-28'), '2026-02-28');
  await rejects(col('date'), '2026-02-30', /valid YYYY-MM-DD/);
  await rejects(col('date'), '28/02/2026', /valid YYYY-MM-DD/);
  await rejects(col('date'), 20260228, /valid YYYY-MM-DD/);
});

test('numbers must be finite and honour precision', async () => {
  assert.equal(await normalizeCellValue(col('number'), 3.14159), 3.14159);
  assert.equal(await normalizeCellValue(col('number', { options: { precision: 2 } }), 3.14159), 3.14);
  assert.equal(await normalizeCellValue(col('number'), 0), 0, 'zero is a value, not empty');
  await rejects(col('number'), '5', /must be a number/);
  await rejects(col('number'), Infinity, /must be a number/);
  await rejects(col('number'), NaN, /must be a number/);
});

test('links must be http(s) addresses', async () => {
  assert.deepEqual(await normalizeCellValue(col('link'), 'https://example.com/a?b=1'), { url: 'https://example.com/a?b=1' });
  assert.deepEqual(await normalizeCellValue(col('link'), { url: 'http://x.io', name: ' Site ' }), { url: 'http://x.io', name: 'Site' });
  await rejects(col('link'), 'javascript:alert(1)', /http/);
  await rejects(col('link'), 'file:///etc/passwd', /http/);
  await rejects(col('link'), 'not a url', /valid web address/);
  await rejects(col('link'), { name: 'x' }, /web address/);
});

test('select values must be existing choice ids, one unless multiple', async () => {
  const options = normalizeColumnOptions('select', { choices: [{ label: 'Todo', color: 'red' }, { label: 'Done', color: 'green' }] });
  const [todo, done] = options.choices.map((c) => c.id);
  const single = col('select', { options });
  assert.deepEqual(await normalizeCellValue(single, todo), [todo]);
  assert.deepEqual(await normalizeCellValue(single, [done]), [done]);
  await rejects(single, [todo, done], /allows one choice/);
  await rejects(single, 'c_missing', /does not exist/);
  const multi = col('select', { options: { ...options, multiple: true } });
  assert.deepEqual(await normalizeCellValue(multi, [todo, done, todo]), [todo, done], 'duplicates collapse');
});

test('select options get stable ids, valid colours, and sane limits', () => {
  const options = normalizeColumnOptions('select', { choices: [{ label: 'A', id: 'keep_me' }, { label: 'B', color: 'purple' }] });
  assert.equal(options.choices[0].id, 'keep_me', 'a given id is kept so renames never break cells');
  assert.equal(options.choices[0].color, 'gray', 'default colour');
  assert.throws(() => normalizeColumnOptions('select', { choices: [{ label: 'A', color: 'chartreuse' }] }), /color must be one of/);
  assert.throws(() => normalizeColumnOptions('select', { choices: [{ label: '' }] }), /Choice labels/);
  assert.throws(() => normalizeColumnOptions('select', { choices: Array.from({ length: 101 }, (_, i) => ({ label: `c${i}` })) }), /at most 100/);
  const dup = normalizeColumnOptions('select', { choices: [{ label: 'A', id: 'same_id' }, { label: 'B', id: 'same_id' }] });
  assert.notEqual(dup.choices[0].id, dup.choices[1].id, 'colliding ids are replaced');
});

test('people must be channel members when a check is supplied', async () => {
  const ctx = { isChannelMember: async (id) => id === 5 };
  assert.deepEqual(await normalizeCellValue(col('user'), 5, ctx), [5]);
  assert.deepEqual(await normalizeCellValue(col('user'), [5], ctx), [5]);
  await rejects(col('user'), 6, /members of its channel/, ctx);
  await rejects(col('user'), [5, 6], /allows one person/, ctx);
  await rejects(col('user'), 'abc', /valid user/, ctx);
  await rejects(col('user'), -1, /valid user/, ctx);
});

test('column names, keys and number options', () => {
  assert.equal(validateColumnName('  Due date '), 'Due date');
  assert.throws(() => validateColumnName(''), /Column names/);
  assert.throws(() => validateColumnName('x'.repeat(81)), /Column names/);
  assert.equal(keyFromName('Due date!'), 'due_date');
  assert.equal(keyFromName('???'), 'column');
  assert.deepEqual(normalizeColumnOptions('number', { precision: 2 }), { precision: 2 });
  assert.throws(() => normalizeColumnOptions('number', { precision: 11 }), /0 to 10/);
  assert.deepEqual(normalizeColumnOptions('checkbox', { anything: 1 }), {});
});
