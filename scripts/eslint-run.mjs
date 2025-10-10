#!/usr/bin/env node
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
export async function collectCrossImportDiagnostics(targets) {
  const { ESLint } = await import('eslint');
  const pluginModule = await import('./eslint-cross-import-rule.cjs');
  const crossImportPlugin = pluginModule.default || pluginModule;
  const eslint = new ESLint({
    cwd: process.cwd(),
    errorOnUnmatchedPattern: false,
    plugins: {
      'cross-import': crossImportPlugin
    }
  });
  const results = await eslint.lintFiles(targets);
  const diagnostics = [];
  let errorCount = 0;
  for (const result of results) {
    errorCount += result.errorCount;
    for (const message of result.messages) {
      if (message.severity !== 2) continue;
      diagnostics.push({
        file: result.filePath,
        line: message.line ?? 0,
        column: message.column ?? 0,
        message: message.message,
        ruleId: message.ruleId || 'cross-import/no-cross-module-imports'
      });
      if (diagnostics.length >= 20) break;
    }
    if (diagnostics.length >= 20) break;
  }
  return { errorCount, diagnostics, results };
}

async function main() {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    console.error('Usage: node scripts/eslint-run.mjs <paths...>');
    process.exit(1);
  }
  try {
    const { ESLint } = await import('eslint');
    const pluginModule = await import('./eslint-cross-import-rule.cjs');
    const crossImportPlugin = pluginModule.default || pluginModule;
    const eslint = new ESLint({
      cwd: process.cwd(),
      errorOnUnmatchedPattern: false,
      plugins: {
        'cross-import': crossImportPlugin
      }
    });
    const results = await eslint.lintFiles(targets);
    const formatter = await eslint.loadFormatter('stylish');
    const output = formatter.format(results);
    if (output.trim().length) {
      process.stdout.write(output);
    }
    const errorCount = results.reduce((acc, r) => acc + r.errorCount, 0);
    if (errorCount > 0) process.exitCode = 1;
  } catch (err) {
    console.error('eslint-run error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || '') === __filename) {
  main();
}
