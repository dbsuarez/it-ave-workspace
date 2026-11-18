const leave = require('./handlers/leave');
const general = require('./handlers/general');

// Where a command may run. A definition lists one or more of:
//   { type: 'global' }                              any channel, including personal ones
//   { type: 'any-channel' }                         any shared channel (not a personal one)
//   { type: 'channel-scope', value: 'hr-inquiry' }  only channels carrying that immutable tag (channels.command_scope)
//
// Definition shape (defaults in `normalize`):
//   name, aliases, category, usage, description, scopes,
//   permission  null (any member) or a permissions-catalogue key checked with can() in the channel; a string that is not
//               in the catalogue (the legacy 'hr.leave.read_self') means "workspace members only",
//   visibility  'private' (answer only to the caller) or 'shared' (the handler posts into the channel),
//   confirm     { preview(ctx, args, options) -> { title, message, confirmLabel } } makes a shared command show a preview and
//               run only after POST /api/commands/confirm,
//   options     { flagName: takesValue } for --flags, maxLength (default 300), allowGuests (default false),
//   handler(ctx, args, options) -> response, ctx = { userId, channelId, channelScope, isPersonal, accountType, io, query }.
const definitions = [];
const byName = new Map();

function normalize(definition) {
  return {
    aliases: [], arguments: [], options: {}, enabled: true, auditPolicy: 'metadata-only', visibility: 'private',
    permission: null, allowGuests: false, category: 'general',
    ...definition,
    usage: definition.usage || `/${definition.name}`,
  };
}

function register(definition) {
  const normalized = normalize(definition);
  definitions.push(normalized);
  byName.set(normalized.name, normalized);
  for (const alias of normalized.aliases) byName.set(alias, normalized);
  return normalized;
}

const hrScope = [{ type: 'channel-scope', value: 'hr-inquiry' }];
const hrPermission = 'hr.leave.read_self';
const hrCommand = (name, description, handler) => register({
  name, description, category: 'hr', scopes: hrScope, permission: hrPermission, handler,
});

hrCommand('leave', 'Summarize your leave balances', (ctx, args) => leave.balances(ctx, args));
hrCommand('leave-count', 'Show your allocated leave credits', (ctx, args) => leave.balances(ctx, args, 'count'));
hrCommand('leave-used', 'Show approved leave charged to your balance', (ctx, args) => leave.balances(ctx, args, 'used'));
hrCommand('leave-remaining', 'Show leave credits still available', (ctx, args) => leave.balances(ctx, args, 'remaining'));
hrCommand('leave-details', 'Show balances and dated leave records', (ctx, args) => leave.balances(ctx, args, 'details'));
hrCommand('leave-history', 'Show your leave application history', (ctx, args) => leave.history(ctx, args));
hrCommand('leave-pending', 'Show your pending leave applications', (ctx, args) => leave.history(ctx, args, true));
hrCommand('leave-status', 'Show recent leave application statuses', (ctx, args) => leave.history(ctx, args));
hrCommand('leave-types', 'Show available leave types', leave.leaveTypes);
hrCommand('leave-request', 'Open the leave request screen', async () => ({
  visibility: 'private', kind: 'open-route', title: 'Request leave', data: { message: 'Open Leave to submit a request.' },
  actions: [{ type: 'open-route', route: 'leave' }],
}));
hrCommand('leave-cancel', 'Cancel an eligible leave request by request number', leave.cancelCandidate);

const hrCommands = definitions.slice();
register({
  name: 'hr-help', category: 'hr', description: 'List HR commands available here',
  scopes: hrScope, permission: hrPermission,
  handler: async () => ({
    visibility: 'private', kind: 'command-help', title: 'HR commands',
    data: { commands: hrCommands.map(({ name, description }) => ({ name, description })) }, actions: [],
  }),
});

register({
  name: 'help', category: 'general', usage: '/help [command]', description: 'List the commands you can use here',
  scopes: [{ type: 'global' }], handler: general.help,
});
register({
  name: 'search', category: 'search', usage: '/search <keywords>', description: 'Search messages, people and files you can see',
  scopes: [{ type: 'global' }], handler: general.search,
});

function publicDefinition(definition) {
  return {
    name: definition.name, aliases: definition.aliases, description: definition.description,
    arguments: definition.arguments, visibility: definition.visibility,
    category: definition.category, usage: definition.usage,
  };
}

module.exports = { definitions, byName, publicDefinition, register };
