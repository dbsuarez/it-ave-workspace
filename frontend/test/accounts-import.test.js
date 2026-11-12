const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, accountsFromRows, credentialsCsv } = require('../accounts-import');

test('CSV: quotes, commas inside quotes, line breaks, BOM and other delimiters', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']], 'semicolons (European Excel)');
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']], 'tabs');
  assert.deepEqual(parseCsv('"multi\nline",z'), [['multi\nline', 'z']]);
  assert.deepEqual(parseCsv(''), []);
});

test('columns are found by header, in any order, with or without a password', () => {
  const { accounts } = accountsFromRows([['Email', 'Username', 'Password'], ['ann@x.test', 'ann', 'Secret-123'], ['bob@x.test', 'bob', '']]);
  assert.deepEqual(accounts, [
    { username: 'ann', email: 'ann@x.test', password: 'Secret-123' },
    { username: 'bob', email: 'bob@x.test', password: '' },
  ]);
  const named = accountsFromRows([['Name', 'E-mail'], ['cy', 'cy@x.test']]).accounts;
  assert.equal(named[0].username, 'cy');
});

test('no header: username, email, password in that order; blank rows are ignored', () => {
  const { accounts } = accountsFromRows([['ann', 'ann@x.test'], ['', ''], ['bob', 'bob@x.test', 'pw-pw-pw-1']]);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[1].password, 'pw-pw-pw-1');
});

test('only emails: usernames are made from them, and the person is told', () => {
  const { accounts, notes } = accountsFromRows([['Email'], ['Ann.Lee@x.test'], ['bob_k@x.test']]);
  assert.deepEqual(accounts.map((a) => a.username), ['ann.lee', 'bob_k']);
  assert.match(notes[0], /usernames are made from the email/);
  assert.equal(accountsFromRows([['ann@x.test'], ['bob@x.test']]).accounts[1].username, 'bob');
});

test('a file with no email column or no rows gives a reason instead of accounts', () => {
  assert.match(accountsFromRows([['Name', 'Team'], ['ann', 'IT']]).notes[0], /No email column/);
  assert.match(accountsFromRows([]).notes[0], /no rows/);
});

test('numbers from a spreadsheet are read as text, and long files are cut at 500 rows', () => {
  assert.equal(accountsFromRows([['username', 'email', 'password'], ['ann', 'a@x.test', 12345678]]).accounts[0].password, '12345678');
  const many = [['username', 'email']];
  for (let i = 0; i < 520; i += 1) many.push([`u${i}`, `u${i}@x.test`]);
  const result = accountsFromRows(many);
  assert.equal(result.accounts.length, 500);
  assert.match(result.notes.join(' '), /first 500/);
});

test('the credentials file quotes cells and defuses spreadsheet formulas', () => {
  const csv = credentialsCsv([{ username: 'ann', email: 'a@x.test', password: 'p,w"1' }, { username: '=cmd', email: 'b@x.test', password: '+1' }]);
  assert.equal(csv.split('\r\n')[0], 'username,email,temporary password');
  assert.equal(csv.split('\r\n')[1], 'ann,a@x.test,"p,w""1"');
  assert.equal(csv.split('\r\n')[2], "'=cmd,b@x.test,+1");
});
