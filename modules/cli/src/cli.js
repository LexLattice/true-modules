export function cliParse(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('CLI.parse expects an argv array.');
  }

  const tokens = argv.slice();
  if (tokens.length && tokens[0].includes('node')) {
    tokens.shift();
  }
  if (tokens.length && tokens[0].endsWith('.js')) {
    tokens.shift();
  }

  const result = {
    command: null,
    options: {},
    positionals: [],
    errors: []
  };

  if (tokens.length === 0) {
    result.errors.push('No command provided.');
    return result;
  }

  result.command = tokens.shift();
  const knownCommands = new Set(['report', 'status']);
  if (!knownCommands.has(result.command)) {
    result.errors.push(`Unknown command: ${result.command}`);
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const [rawKey, rawValue] = token.slice(2).split('=', 2);
      if (!rawKey) {
        result.errors.push('Invalid flag syntax.');
        continue;
      }
      let value = rawValue;
      if (value === undefined) {
        const next = tokens[i + 1];
        if (next && !next.startsWith('-')) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      result.options[rawKey] = value;
      continue;
    }
    if (token.startsWith('-')) {
      const flags = token.slice(1).split('');
      for (const flag of flags) {
        result.options[flag] = true;
      }
      continue;
    }
    result.positionals.push(token);
  }

  if ('format' in result.options) {
    const allowedFormats = new Set(['json', 'text']);
    if (!allowedFormats.has(result.options.format)) {
      result.errors.push(`Unsupported format: ${result.options.format}`);
    }
  }

  if (result.command === 'report' && result.positionals.length === 0) {
    result.errors.push('report command expects a message argument');
  }

  return result;
}
