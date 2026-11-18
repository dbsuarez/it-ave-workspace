// IT Avenue Workspace - the "Seen by" line under a channel's header. Pure: which people show, and whether the rest can be opened.
// Four people show at first; "+N more" opens the whole list in place and "show less" folds it back.

const READ_RECEIPTS_SHOWN = 4;

// users: [{ id, name?, username }] in the order they were seen. expanded: whether the whole list is open.
function readReceiptsSummary(users, expanded, limit = READ_RECEIPTS_SHOWN) {
  const list = users || [];
  const canToggle = list.length > limit;
  const open = Boolean(expanded) && canToggle;
  const visible = open ? list : list.slice(0, limit);
  return {
    visible, hidden: open ? 0 : Math.max(0, list.length - limit), canToggle, expanded: open,
    text: visible.map((user) => user.name || user.username).join(', '),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { readReceiptsSummary };
}
