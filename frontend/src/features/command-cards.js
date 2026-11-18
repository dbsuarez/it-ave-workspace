// IT Avenue Workspace - private slash-command result cards and the grouped command menu.
//
// Pure functions: they take a server response and return HTML, escaping every value. Loaded before renderer.js;
// defines functions only. Buttons come only from an allowlist of action types and routes, so a response can never
// make the client run anything it does not already know how to do.

const COMMAND_CATEGORY_ORDER = ['general', 'search', 'announcements', 'polls', 'hr'];
const COMMAND_CATEGORY_LABELS = { general: 'General', search: 'Search', announcements: 'Announcements', polls: 'Polls', hr: 'HR' };

function commandCardEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function commandCardValue(value) {
  return value === null ? 'No limit' : String(value ?? '—');
}

function commandCategoryLabel(category) {
  return COMMAND_CATEGORY_LABELS[category] || String(category || 'Other');
}

function commandCardActions(actions) {
  return (actions || []).map((action) => {
    if (!action || typeof action !== 'object') return '';
    if (action.type === 'open-route' && action.route === 'leave') {
      return '<button type="button" class="btn" data-command-route="leave">Open Leave</button>';
    }
    if (action.type === 'open-route' && action.route === 'search' && typeof action.query === 'string' && action.query.length <= 100) {
      return `<button type="button" class="btn" data-command-route="search" data-command-query="${commandCardEscape(action.query)}">Open all results</button>`;
    }
    if (action.type === 'cancel-leave' && Number.isSafeInteger(Number(action.requestId))) {
      return `<button type="button" class="btn danger" data-command-cancel-leave="${Number(action.requestId)}">Cancel request</button>`;
    }
    return '';
  }).join('');
}

function commandCardHtml(response, commandText) {
  const data = response.data || {};
  const assistant = response.category === 'hr' ? 'HR Assistant' : 'Workspace Assistant';
  const balances = (data.leaveTypes || []).map((row) => `
    <tr><th>${commandCardEscape(row.name)}</th><td>${commandCardValue(row.entitled)}</td><td>${commandCardValue(row.used)}</td><td>${commandCardValue(row.pending)}</td><td>${commandCardValue(row.remaining)}</td></tr>`).join('');
  const requests = (data.requests || []).map((row) => `
    <li><strong>${commandCardEscape(row.typeName)}</strong> · ${commandCardEscape(row.startDate)}${row.endDate !== row.startDate ? ` – ${commandCardEscape(row.endDate)}` : ''} · ${commandCardEscape(String(row.days))} day${Number(row.days) === 1 ? '' : 's'} <span class="command-status">${commandCardEscape(row.status)}</span></li>`).join('');
  const commands = (data.commands || []).map((row) => `<li><strong>/${commandCardEscape(row.name)}</strong> — ${commandCardEscape(row.description)}</li>`).join('');
  const table = data.table && Array.isArray(data.table.head) && Array.isArray(data.table.rows)
    ? `<div class="command-table-wrap"><table><thead><tr>${data.table.head.map((cell) => `<th>${commandCardEscape(cell)}</th>`).join('')}</tr></thead><tbody>${data.table.rows.map((row) => `<tr>${row.map((cell) => `<td>${commandCardEscape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '';
  const list = Array.isArray(data.list) && data.list.length
    ? `<ul class="command-records">${data.list.map((row) => `<li><strong>${commandCardEscape(row.title)}</strong>${row.text ? ` — ${commandCardEscape(row.text)}` : ''}</li>`).join('')}</ul>`
    : '';
  return `
    <header><div><span class="command-assistant">${assistant}</span><span class="command-private-label">Only visible to you</span></div><button type="button" class="command-dismiss" aria-label="Dismiss private response">&times;</button></header>
    <p class="command-echo">You: ${commandCardEscape(commandText)}</p>
    <h3>${commandCardEscape(response.title || (response.category === 'hr' ? 'HR response' : 'Response'))}</h3>
    ${response.period ? `<p class="command-period">Period: ${commandCardEscape(response.period)}</p>` : ''}
    ${data.message ? `<p>${commandCardEscape(data.message)}</p>` : ''}
    ${balances ? `<div class="command-table-wrap"><table><thead><tr><th>Type</th><th>Credits</th><th>Used</th><th>Pending</th><th>Available</th></tr></thead><tbody>${balances}</tbody></table></div>` : ''}
    ${table}
    ${requests ? `<ul class="command-records">${requests}</ul>` : (!balances && 'requests' in data ? '<p>No matching leave requests.</p>' : '')}
    ${commands ? `<ul class="command-records">${commands}</ul>` : ''}
    ${list}
    ${data.note ? `<p class="command-note">${commandCardEscape(data.note)}</p>` : ''}
    ${commandCardActions(response.actions)}`;
}

// [{ category, items }] with the known categories first, in a fixed order; each group keeps the commands' own order.
function groupCommandsByCategory(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  const known = COMMAND_CATEGORY_ORDER.filter((category) => groups.has(category));
  const others = [...groups.keys()].filter((category) => !COMMAND_CATEGORY_ORDER.includes(category));
  return [...known, ...others].map((category) => ({ category, items: groups.get(category) }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { commandCardHtml, groupCommandsByCategory, commandCategoryLabel };
}
