// The Sheets grid: Jspreadsheet CE behind a small, framework-free handle. Bundled by scripts/build-sheets.js into
// src/vendor/sheet-grid.js (global ITASheet). The rest of the app never touches the library directly.
//
//   const grid = ITASheet.mount(element, { tabs, readOnly, onChange });
//   grid.getTabs()   -> [{ id, name, rows, widths }]   the sheet as the server stores it (empty trailing rows and cells trimmed)
//   grid.setTabs(t)  replaces what is shown (used after a merge)
//   grid.destroy()
//
// tabs: [{ id, name, rows: [[string...]...], widths?: [number...] }]. A cell is text; a formula is text starting with "=".
import jspreadsheet from 'jspreadsheet-ce';

const MIN_COLUMNS = 26;
const MIN_ROWS = 60;

const newTabId = () => `t${Math.random().toString(16).slice(2, 10)}`;

// Removes empty rows at the end and empty cells at the end of each row, so a mostly empty sheet saves small.
function trimRows(rows) {
  const out = rows.map((row) => {
    const cells = row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)));
    let end = cells.length;
    while (end > 0 && cells[end - 1] === '') end -= 1;
    return cells.slice(0, end);
  });
  let last = out.length;
  while (last > 0 && out[last - 1].length === 0) last -= 1;
  return out.slice(0, last);
}

function mount(element, options = {}) {
  const readOnly = Boolean(options.readOnly);
  let instance = null;
  let lastNames = '';
  let timer = null;

  const worksheetOptions = (tab) => ({
    data: tab.rows.length ? tab.rows : [[]],
    worksheetName: tab.name,
    minDimensions: [MIN_COLUMNS, MIN_ROWS],
    tableOverflow: true,
    tableWidth: '100%',
    tableHeight: '100%',
    lazyLoading: true,
    loadingSpin: false,
    freezeColumns: 0,
    columnSorting: !readOnly,
    editable: !readOnly,
    columns: tab.widths ? tab.widths.map((width) => ({ width })) : undefined,
    tabId: tab.id,
  });

  const changed = () => { if (options.onChange) options.onChange(); };
  const watchNames = () => {
    // renaming a tab has no event in the library, so the names are looked at while the grid is open
    const names = instance ? instance.map((sheet) => sheet.options.worksheetName).join('\u0001') : '';
    if (lastNames && names !== lastNames) changed();
    lastNames = names;
  };

  const build = (tabs) => {
    element.innerHTML = '';
    instance = jspreadsheet(element, {
      worksheets: tabs.map(worksheetOptions),
      tabs: true,
      toolbar: false,
      contextMenu: readOnly ? () => false : undefined,
      onafterchanges: changed, oninsertrow: changed, ondeleterow: changed, oninsertcolumn: changed, ondeletecolumn: changed,
      onmoverow: changed, onmovecolumn: changed, onpaste: changed, onsort: changed, onundo: changed, onredo: changed,
      onresizecolumn: changed, oncreateworksheet: changed, ondeleteworksheet: changed,
    });
    lastNames = instance.map((sheet) => sheet.options.worksheetName).join('\u0001');
    clearInterval(timer);
    timer = setInterval(watchNames, 1500);
  };
  build(options.tabs || [{ id: newTabId(), name: 'Sheet1', rows: [] }]);

  return {
    getTabs() {
      return instance.map((sheet) => {
        if (!sheet.options.tabId) sheet.options.tabId = newTabId();
        const columns = sheet.options.columns || [];
        const widths = columns.map((column) => Number(column && column.width) || 100);
        return { id: sheet.options.tabId, name: sheet.options.worksheetName, rows: trimRows(sheet.getData()), widths };
      });
    },
    setTabs(tabs) { build(tabs); },
    destroy() {
      clearInterval(timer);
      try { jspreadsheet.destroy(element, true); } catch (err) { /* already gone */ }
      element.innerHTML = '';
    },
  };
}

export { mount };
