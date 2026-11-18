// IT Avenue Workspace - Sheets: CSV in and out. Pure and tested.
//
// Export defuses cells that Excel could run as a formula (the same rule as the leave export on the server): a cell starting with
// = or @ gets a leading apostrophe, and so does one starting with + or - unless it is an ordinary number. Import reads commas,
// semicolons (some Excel languages) or tabs, quoted cells, doubled quotes and line breaks inside cells.

function csvDefuse(cell) {
  const value = String(cell ?? '');
  if (/^[=@\t\r]/.test(value) || (/^[+-]/.test(value) && !/^[+-][\d\s().,-]+$/.test(value))) return `'${value}`;
  return value;
}

function rowsToCsv(rows) {
  return rows.map((row) => `${row.map((cell) => {
    const value = csvDefuse(cell);
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join(',')}\r\n`).join('');
}

// The separator of a file: whichever of comma, semicolon and tab is most common in the first line outside quotes (comma on a tie).
function csvSeparator(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  return Object.keys(counts).reduce((best, key) => (counts[key] > counts[best] ? key : best), ',');
}

function parseCsv(input) {
  const text = String(input || '').replace(/^﻿/, '');
  if (!text.trim()) return [];
  const separator = csvSeparator(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === separator) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function csvFileName(sheetTitle, tabName) {
  const safe = (value) => String(value || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const parts = [safe(sheetTitle), safe(tabName)].filter(Boolean);
  return `${parts.length ? parts.join('-') : 'sheet'}.csv`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCsv, rowsToCsv, csvFileName };
}
