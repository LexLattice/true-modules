#!/usr/bin/env node
import process from 'process';

const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const payload = chunks.join('');
  try {
    const summary = JSON.parse(payload || '{}');
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } catch (err) {
    console.error('echo-hook error:', err.message);
    process.exit(1);
  }
});
process.stdin.resume();
