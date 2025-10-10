const path = require('path');

module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    }
  ],
  plugins: ['local-rules'],
  rules: {
    'local-rules/cross-module-imports': 'error'
  },
  settings: {
    'local-rules': {
      'cross-module-imports': path.resolve(__dirname, 'scripts/eslint-cross-import-rule.cjs')
    }
  }
};
