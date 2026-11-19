// General-purpose commands that work in every channel: /help and /search. Both answer privately.
const { searchWorkspace, validateSearchTerm } = require('../../searchService');

const CATEGORY_ORDER = ['general', 'search', 'announcements', 'polls', 'hr'];
const CATEGORY_LABELS = { general: 'General', search: 'Search', announcements: 'Announcements', polls: 'Polls', hr: 'HR' };
const label = (category) => CATEGORY_LABELS[category] || String(category);
const rank = (category) => (CATEGORY_ORDER.includes(category) ? CATEGORY_ORDER.indexOf(category) : CATEGORY_ORDER.length);

const privateCard = (kind, title, data, actions = []) => ({ visibility: 'private', kind, title, data, actions });

// /help [command] - what you can use in this channel, or one command in detail. A command that is not available here
// is reported as unknown, so help never reveals what exists elsewhere.
async function help(ctx, args) {
  const available = await ctx.available();
  if (args.length) {
    const wanted = args[0].replace(/^\//, '').toLowerCase();
    const match = available.find((definition) => definition.name === wanted || definition.aliases.includes(wanted));
    if (!match) return privateCard('command-help', 'Help', { message: `No command named /${wanted} here. Try /help for the list.` });
    return privateCard('command-help', `/${match.name}`, { table: { head: ['Usage', 'Description'], rows: [[match.usage, match.description]] } });
  }
  const rows = [...available]
    .sort((a, b) => rank(a.category) - rank(b.category))
    .map((definition) => [definition.usage, definition.description, label(definition.category)]);
  return privateCard('command-help', 'Commands available here', {
    table: { head: ['Command', 'What it does', 'Category'], rows },
    note: 'Type / in the message box to pick a command. Start a message with // to send a literal /.',
  });
}

const preview = (text) => String(text || '').replace(/\s+/g, ' ').slice(0, 120);

// /search <keywords> - the same results as the Search box (shared searchWorkspace), up to 5 of each kind.
async function search(ctx, args) {
  const term = validateSearchTerm(args.join(' '));
  const found = await searchWorkspace(ctx.query, ctx.userId, term);
  const where = (item) => `#${item.channelName}${item.topicTitle ? ` › ${item.topicTitle}` : ''}`;
  const rows = [
    ...found.topics.map((t) => ['Topic', t.title, `#${t.channelName}`]),
    ...found.messages.map((m) => ['Message', `${m.fullName || m.username}: ${preview(m.content)}`, where(m)]),
    ...found.directMessages.map((m) => ['Direct message', `${m.fullName || m.username}: ${preview(m.content)}`, 'Direct']),
    ...found.people.map((p) => ['Person', p.fullName || p.username, p.fullName ? p.username : '']),
    ...found.files.map((f) => ['File', f.name, f.channelName ? where(f) : 'Direct']),
  ];
  const actions = [{ type: 'open-route', route: 'search', query: term }];
  if (!rows.length) return privateCard('search-results', `Search results for "${term}"`, { message: `Nothing found for "${term}".` }, actions);
  return privateCard('search-results', `Search results for "${term}"`, {
    table: { head: ['Kind', 'Result', 'Where'], rows },
    note: 'Showing up to 5 of each kind.',
  }, actions);
}

module.exports = { help, search };
