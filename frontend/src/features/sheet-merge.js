// IT Avenue Workspace - Sheets: merging my unsaved edits into the version someone else saved first. Pure and tested.
//
// base = the sheet as I last got it from the server, mine = what is on my screen, theirs = what the server has now.
// Cell by cell: a cell I changed stays mine (mine is the newer edit if we both changed it), any other cell comes from the server.
// Tabs are matched by their id. Cells are matched by position, so adding or removing rows or columns while someone else edits the
// same sheet can mix cells up; the screen says so, and a sheet with one editor at a time is not affected.

const cellAt = (rows, r, c) => (rows[r] && rows[r][c] !== undefined ? rows[r][c] : '');

function trimmed(rows) {
  const out = rows.map((row) => {
    let end = row.length;
    while (end > 0 && row[end - 1] === '') end -= 1;
    return row.slice(0, end);
  });
  let last = out.length;
  while (last > 0 && out[last - 1].length === 0) last -= 1;
  return out.slice(0, last);
}

function mergeTab(base, mine, theirs) {
  const baseRows = base ? base.rows : [];
  const rowCount = Math.max(baseRows.length, mine.rows.length, theirs.rows.length);
  const columnCount = Math.max(...[baseRows, mine.rows, theirs.rows].map((rows) => rows.reduce((max, row) => Math.max(max, row.length), 0)));
  let collisions = 0;
  const rows = [];
  for (let r = 0; r < rowCount; r += 1) {
    const row = [];
    for (let c = 0; c < columnCount; c += 1) {
      const b = cellAt(baseRows, r, c);
      const m = cellAt(mine.rows, r, c);
      const t = cellAt(theirs.rows, r, c);
      if (m !== b && t !== b && m !== t) collisions += 1;
      row.push(m !== b ? m : t);
    }
    rows.push(row);
  }
  const merged = { id: theirs.id, name: base && mine.name === base.name ? theirs.name : mine.name, rows: trimmed(rows) };
  const widthOf = (tab, i) => (tab && tab.widths ? tab.widths[i] : undefined);
  const count = Math.max(...[base, mine, theirs].map((tab) => (tab && tab.widths ? tab.widths.length : 0)));
  if (count) {
    merged.widths = Array.from({ length: count }, (_, i) => {
      const b = widthOf(base, i); const m = widthOf(mine, i); const t = widthOf(theirs, i);
      return (m !== undefined && m !== b ? m : (t !== undefined ? t : (m !== undefined ? m : 100)));
    });
  }
  return { tab: merged, collisions };
}

// -> { data: { tabs }, collisions }  (collisions: cells we both changed, and my edits to a tab someone deleted)
function mergeSheetData(base, mine, theirs) {
  const byId = (data) => new Map(data.tabs.map((tab) => [tab.id, tab]));
  const baseTabs = byId(base); const myTabs = byId(mine); const theirTabs = byId(theirs);
  let collisions = 0;
  const tabs = [];
  for (const theirTab of theirs.tabs) {
    const myTab = myTabs.get(theirTab.id);
    if (!myTab) {
      // I deleted it: keep it deleted only if they did not change it; otherwise their version stays
      if (baseTabs.has(theirTab.id) && JSON.stringify(baseTabs.get(theirTab.id)) === JSON.stringify(theirTab)) continue;
      tabs.push(JSON.parse(JSON.stringify(theirTab)));
      continue;
    }
    const merged = mergeTab(baseTabs.get(theirTab.id) || null, myTab, theirTab);
    collisions += merged.collisions;
    tabs.push(merged.tab);
  }
  for (const myTab of mine.tabs) {
    if (theirTabs.has(myTab.id)) continue;
    if (baseTabs.has(myTab.id)) { // they deleted it
      if (JSON.stringify(baseTabs.get(myTab.id)) !== JSON.stringify(myTab)) collisions += 1;
      continue;
    }
    tabs.push(JSON.parse(JSON.stringify(myTab))); // a tab I added
  }
  return { data: { tabs }, collisions };
}

function sheetsEqual(a, b) {
  const plain = (data) => JSON.stringify(data.tabs.map((tab) => ({ id: tab.id, name: tab.name, rows: trimmed(tab.rows), widths: tab.widths || null })));
  return plain(a) === plain(b);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mergeSheetData, sheetsEqual };
}
