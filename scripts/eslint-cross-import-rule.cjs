const path = require('path');

function findModuleInfo(filePath) {
  const normalized = path.normalize(filePath);
  const segments = normalized.split(path.sep);
  const modulesIndex = segments.lastIndexOf('modules');
  if (modulesIndex === -1 || modulesIndex + 1 >= segments.length) {
    return null;
  }
  const moduleId = segments[modulesIndex + 1];
  const moduleRoot = path.join(...segments.slice(0, modulesIndex + 2));
  return { moduleId, moduleRoot };
}

function resolvesOutsideModule(filename, importPath) {
  const info = findModuleInfo(filename);
  if (!info) return false;
  const resolved = path.normalize(path.resolve(path.dirname(filename), importPath));
  return !resolved.startsWith(info.moduleRoot + path.sep);
}

function targetsDifferentModule(filename, specifier) {
  const info = findModuleInfo(filename);
  if (!info) return false;
  const normalized = specifier.replace(/\\/g, '/');
  if (normalized.includes('runtimes/ts/ports')) return false;
  const match = normalized.match(/modules\/([^/]+)/);
  if (!match) return false;
  const target = match[1];
  return target && target !== info.moduleId;
}

module.exports = {
  rules: {
    'no-cross-module-imports': {
      meta: {
        type: 'problem',
        docs: {
          description: 'disallow imports that cross module boundaries',
          recommended: false
        },
        schema: []
      },
      create(context) {
        const filename = context.getFilename();
        if (!filename || filename === '<text>') return {};
        const info = findModuleInfo(filename);
        if (!info) return {};

        function checkLiteral(node, value) {
          if (typeof value !== 'string') return;
          const normalized = value.replace(/\\/g, '/');
          if (normalized.includes('runtimes/ts/ports')) return;
          if (value.startsWith('.')) {
            if (resolvesOutsideModule(filename, value)) {
              context.report({
                node,
                message: `Relative import "${value}" escapes module "${info.moduleId}".`
              });
            }
          } else if (targetsDifferentModule(filename, value)) {
            context.report({
              node,
              message: `Import "${value}" targets different module while checking "${info.moduleId}".`
            });
          }
        }

        return {
          ImportDeclaration(node) {
            checkLiteral(node.source, node.source && node.source.value);
          },
          CallExpression(node) {
            if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
            if (!node.arguments.length) return;
            const arg = node.arguments[0];
            if (arg.type === 'Literal') {
              checkLiteral(arg, arg.value);
            }
          }
        };
      }
    }
  }
};
