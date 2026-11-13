const MAX_COMMAND_LENGTH = 300;

function parseCommand(input) {
  if (typeof input !== 'string') throw Object.assign(new Error('Command must be text'), { status: 400 });
  const text = input.trim();
  if (!text.startsWith('/')) throw Object.assign(new Error('Commands start with /'), { status: 400 });
  if (text.length > MAX_COMMAND_LENGTH) throw Object.assign(new Error(`Commands can be at most ${MAX_COMMAND_LENGTH} characters`), { status: 400 });
  const parts = text.slice(1).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw Object.assign(new Error('Choose a command'), { status: 400 });
  return { name: parts.shift().toLowerCase(), args: parts };
}

module.exports = { MAX_COMMAND_LENGTH, parseCommand };
