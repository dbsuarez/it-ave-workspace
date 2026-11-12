// Reading a list of people to create accounts for, from a CSV or an Excel (.xlsx) file.
// Pure parsing lives here (covered by test/accounts-import.test.js); main.js shows the file dialog.
//
// Columns are found by their header: username (or user, login, name), email (or e-mail), password (optional),
// and optionally last name (surname), first name (given name) and middle name.
// Without a header row the order is username, email, password. With an email but no username column, the
// username is made from the part of the email before the @.
const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 500;

// RFC 4180: quoted fields may hold commas, quotes ("") and line breaks. Delimiter is a comma, semicolon or tab.
function parseCsv(text) {
  const source = String(text || '').replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  const delimiter = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const USERNAME_HEADERS = ['username', 'user name', 'user', 'login', 'name'];
const EMAIL_HEADERS = ['email', 'e-mail', 'email address', 'e-mail address', 'mail'];
const PASSWORD_HEADERS = ['password', 'temporary password', 'temp password', 'initial password'];
const LAST_HEADERS = ['last name', 'lastname', 'last', 'surname', 'family name'];
const FIRST_HEADERS = ['first name', 'firstname', 'first', 'given name'];
const MIDDLE_HEADERS = ['middle name', 'middlename', 'middle', 'middle initial'];

const cell = (value) => (value === null || value === undefined ? '' : String(value).trim());

function usernameFromEmail(email) {
  return email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 50);
}

// rows: an array of arrays (from a CSV or a worksheet) -> { accounts: [{ username, email, password }], notes: [] }
function accountsFromRows(rows) {
  const notes = [];
  const filled = rows.map((row) => (Array.isArray(row) ? row.map(cell) : [])).filter((row) => row.some((value) => value !== ''));
  if (!filled.length) return { accounts: [], notes: ['The file has no rows.'] };

  const header = filled[0].map((value) => value.toLowerCase());
  const find = (names) => header.findIndex((value) => names.includes(value));
  let emailCol = find(EMAIL_HEADERS);
  let userCol = find(USERNAME_HEADERS);
  let passCol = find(PASSWORD_HEADERS);
  let lastCol = find(LAST_HEADERS);
  let firstCol = find(FIRST_HEADERS);
  let middleCol = find(MIDDLE_HEADERS);
  const hasHeader = [emailCol, userCol, passCol, lastCol, firstCol, middleCol].some((index) => index !== -1);
  let body = filled;
  if (hasHeader) {
    body = filled.slice(1);
  } else {
    userCol = 0; emailCol = 1; passCol = 2; lastCol = 3; firstCol = 4; middleCol = 5;
    // a single column of email addresses
    if (filled.every((row) => row.length === 1 && row[0].includes('@'))) { userCol = -1; emailCol = 0; passCol = -1; lastCol = -1; firstCol = -1; middleCol = -1; }
  }
  if (emailCol === -1) return { accounts: [], notes: ['No email column was found. Add a header row with "username" and "email".'] };
  if (userCol === -1) notes.push('There is no username column, so usernames are made from the email addresses.');

  if (body.length > MAX_ROWS) {
    notes.push(`Only the first ${MAX_ROWS} rows were read.`);
    body = body.slice(0, MAX_ROWS);
  }
  const accounts = body.map((row) => {
    const email = cell(row[emailCol]);
    const username = userCol === -1 ? usernameFromEmail(email) : cell(row[userCol]);
    const password = passCol === -1 ? '' : cell(row[passCol]);
    const account = { username, email, password };
    const name = (col) => (col === -1 ? '' : cell(row[col]));
    if (name(lastCol)) account.lastName = name(lastCol);
    if (name(firstCol)) account.firstName = name(firstCol);
    if (name(middleCol)) account.middleName = name(middleCol);
    return account;
  });
  return { accounts, notes };
}

async function readAccountFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!['.csv', '.txt', '.xlsx'].includes(extension)) throw new Error('Choose a .csv or .xlsx file');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('That is not a file');
  if (stat.size > MAX_FILE_BYTES) throw new Error('That file is larger than 2 MB');
  if (extension === '.xlsx') {
    const readXlsxFile = require('read-excel-file/node');
    const rows = await readXlsxFile(filePath); // the first worksheet
    return accountsFromRows(rows);
  }
  return accountsFromRows(parseCsv(fs.readFileSync(filePath, 'utf8')));
}

// The passwords just issued, as a CSV the Superadmin can keep or hand out. Names and emails starting with
// = + - @ are prefixed so a spreadsheet never runs them as formulas; passwords are written exactly as issued.
function credentialsCsv(created) {
  const safe = (value, defuse) => {
    let text = String(value === null || value === undefined ? '' : value);
    if (defuse && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return ['username,email,temporary password', ...created.map((c) => [safe(c.username, true), safe(c.email, true), safe(c.password, false)].join(','))].join('\r\n') + '\r\n';
}

module.exports = { parseCsv, accountsFromRows, readAccountFile, credentialsCsv, MAX_ROWS };
