// The left rail, arranged once by an Owner for everyone (moderation_settings.rail_layout, saved with PUT /api/settings/sidebar/rail
// under the manage_workspace permission, like the workspace channel sections). A layout is { order: [keys on the rail], more: [keys in
// the More menu] }; together they list every section exactly once. Pure.

// The sections of the rail, in their default order. Keys are the app's section names (data-rail on the buttons).
const RAIL_KEYS = ['home', 'dms', 'activity', 'later', 'files', 'notes', 'canvas2', 'drawings', 'sheets', 'knowledgebase', 'people', 'huddle', 'moderation', 'lists'];
const DEFAULT_RAIL = { order: RAIL_KEYS.filter((key) => key !== 'lists'), more: ['lists'] };

const known = new Set(RAIL_KEYS);
const keysOf = (value) => (Array.isArray(value) ? value.filter((key) => typeof key === 'string' && known.has(key)) : []);

// Anything sent is cleaned into a full layout: unknown names and repeats dropped, a section in both lists stays on the rail, Home is
// always the first section on the rail, and every section that was left out goes to the end of the rail.
function cleanRailLayout(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { order: [...DEFAULT_RAIL.order], more: [...DEFAULT_RAIL.more] };
  const seen = new Set();
  const take = (list) => list.filter((key) => (seen.has(key) ? false : (seen.add(key), true)));
  const order = take(['home', ...keysOf(input.order)]); // Home first, and never in More
  const more = take(keysOf(input.more));
  const missing = RAIL_KEYS.filter((key) => !seen.has(key));
  if (!Array.isArray(input.order) && !Array.isArray(input.more)) return { order: [...DEFAULT_RAIL.order], more: [...DEFAULT_RAIL.more] };
  return { order: [...order, ...missing], more };
}

module.exports = { RAIL_KEYS, DEFAULT_RAIL, cleanRailLayout };
