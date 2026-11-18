const MAX_COMMAND_LENGTH = 300;

const fail = (message) => Object.assign(new Error(message), { status: 400 });

// Splits the text after the command name into tokens. Double quotes group words (a backslash can escape a quote
// or a backslash inside them); a quote only opens a token at the start of a word.
function tokenize(rest) {
  const tokens = [];
  let i = 0;
  while (i < rest.length) {
    if (/\s/.test(rest[i])) { i += 1; continue; }
    if (rest[i] === '"') {
      let text = '';
      i += 1;
      let closed = false;
      while (i < rest.length) {
        const ch = rest[i];
        if (ch === '\\' && (rest[i + 1] === '"' || rest[i + 1] === '\\')) { text += rest[i + 1]; i += 2; continue; }
        if (ch === '"') { closed = true; i += 1; break; }
        text += ch;
        i += 1;
      }
      if (!closed) throw fail('Close the quote: every " needs a matching "');
      if (!text.trim()) throw fail('A quoted argument cannot be empty');
      tokens.push({ text, quoted: true });
      continue;
    }
    let text = '';
    while (i < rest.length && !/\s/.test(rest[i])) { text += rest[i]; i += 1; }
    tokens.push({ text, quoted: false });
  }
  return tokens;
}

// parseCommand('/poll "Q?" "A" "B" --closes 2h', { flagsFor }) -> { name: 'poll', args: ['Q?', 'A', 'B'], options: { closes: '2h' } }
// flagsFor(name) returns { flagName: takesValue } for that command, or undefined when it has no options.
function parseCommand(input, { maxLength = MAX_COMMAND_LENGTH, flagsFor, rawText = false } = {}) {
  if (typeof input !== 'string') throw fail('Command must be text');
  const text = input.trim();
  if (!text.startsWith('/')) throw fail('Commands start with /');
  if (text.length > maxLength) throw fail(`Commands can be at most ${maxLength} characters`);
  const head = text.match(/^\/(\S*)/);
  const name = head[1].toLowerCase();
  if (!name) throw fail('Choose a command');
  const raw = text.slice(head[0].length).replace(/^\s+/, ''); // the text after the name, exactly as typed
  // rawText commands (such as /announce) take everything after the name as plain text: no quotes, no --flags
  if (rawText) return { name, args: raw ? [raw] : [], options: {}, text: raw };
  const spec = (typeof flagsFor === 'function' && flagsFor(name)) || {};
  const tokens = tokenize(raw);
  const args = [];
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.quoted || !token.text.startsWith('--') || token.text.length === 2) {
      args.push(token.text);
      continue;
    }
    const [flag, inline] = [token.text.slice(2).split('=')[0], token.text.includes('=') ? token.text.slice(token.text.indexOf('=') + 1) : null];
    if (!Object.prototype.hasOwnProperty.call(spec, flag)) throw fail(`Unknown option --${flag}`);
    if (!spec[flag]) { options[flag] = true; continue; }
    if (inline) { options[flag] = inline; continue; }
    const next = tokens[index + 1];
    if (!next || (!next.quoted && next.text.startsWith('--'))) throw fail(`--${flag} needs a value`);
    options[flag] = next.text;
    index += 1;
  }
  return { name, args, options, text: raw };
}

module.exports = { MAX_COMMAND_LENGTH, parseCommand };
