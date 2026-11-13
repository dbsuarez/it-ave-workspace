const leave = require('./handlers/leave');

const scope = [{ type: 'channel-scope', value: 'hr-inquiry' }];
const permission = 'hr.leave.read_self';
const command = (name, description, handler, options = {}) => ({
  name, aliases: [], description, scopes: scope, permission, visibility: 'private',
  arguments: options.arguments || [], enabled: true, auditPolicy: 'metadata-only', handler,
});

const definitions = [
  command('leave', 'Summarize your leave balances', (ctx, args) => leave.balances(ctx, args)),
  command('leave-count', 'Show your allocated leave credits', (ctx, args) => leave.balances(ctx, args, 'count')),
  command('leave-used', 'Show approved leave charged to your balance', (ctx, args) => leave.balances(ctx, args, 'used')),
  command('leave-remaining', 'Show leave credits still available', (ctx, args) => leave.balances(ctx, args, 'remaining')),
  command('leave-details', 'Show balances and dated leave records', (ctx, args) => leave.balances(ctx, args, 'details')),
  command('leave-history', 'Show your leave application history', (ctx, args) => leave.history(ctx, args)),
  command('leave-pending', 'Show your pending leave applications', (ctx, args) => leave.history(ctx, args, true)),
  command('leave-status', 'Show recent leave application statuses', (ctx, args) => leave.history(ctx, args)),
  command('leave-types', 'Show available leave types', leave.leaveTypes),
  command('leave-request', 'Open the leave request screen', async () => ({
    visibility: 'private', kind: 'open-route', title: 'Request leave', data: { message: 'Open Leave to submit a request.' },
    actions: [{ type: 'open-route', route: 'leave' }],
  })),
  command('leave-cancel', 'Cancel an eligible leave request by request number', leave.cancelCandidate),
];

const help = {
  name: 'hr-help', aliases: ['help'], description: 'List HR commands available here', scopes: scope,
  permission, visibility: 'private', arguments: [], enabled: true, auditPolicy: 'metadata-only',
  handler: async () => ({
    visibility: 'private', kind: 'command-help', title: 'HR commands',
    data: { commands: definitions.map(({ name, description }) => ({ name, description })) }, actions: [],
  }),
};
definitions.push(help);

const byName = new Map();
for (const definition of definitions) {
  byName.set(definition.name, definition);
  for (const alias of definition.aliases) byName.set(alias, definition);
}

function publicDefinition(definition) {
  return {
    name: definition.name, aliases: definition.aliases, description: definition.description,
    arguments: definition.arguments, visibility: definition.visibility,
  };
}

module.exports = { definitions, byName, publicDefinition };
