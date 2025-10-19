import fs from 'fs/promises';
import path from 'path';
import process from 'process';

function normalizeLines(contents) {
  if (!contents) return [];
  return contents
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export async function reporterWrite(message, options = {}) {
  if (typeof message !== 'string') {
    throw new TypeError('Reporter.write expects a string message.');
  }
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error('Reporter.write requires a non-empty message.');
  }

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const logDir = options.logDir
    ? path.resolve(options.logDir)
    : path.join(cwd, 'artifacts');
  const fileName = options.fileName || 'reporter.log';
  const logFile = path.join(logDir, fileName);

  await fs.mkdir(logDir, { recursive: true });

  let prior = [];
  try {
    const existing = await fs.readFile(logFile, 'utf8');
    prior = normalizeLines(existing);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  const seen = new Set(prior);
  const alreadyLogged = seen.has(trimmed);
  if (!alreadyLogged) {
    await fs.appendFile(logFile, `${trimmed}\n`, 'utf8');
    prior.push(trimmed);
  }

  return {
    file: logFile,
    appended: !alreadyLogged,
    lines: prior.slice()
  };
}
