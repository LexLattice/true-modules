#!/usr/bin/env node
import { spawn } from 'child_process';
import process from 'process';

const tmArgs = process.argv.slice(2);
const child = spawn('node', ['tm.mjs', ...tmArgs], {
  stdio: 'inherit'
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
