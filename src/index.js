'use strict';

const path = require('path');
const mapping = require('@ember-data/rfc395-data');

function isDisallowed(disallowedList, importPath, exportName) {
  if (Array.isArray(disallowedList)) {
    return disallowedList.indexOf(importPath) > -1;
  } else {
    let disallowedExports = disallowedList[importPath];

    return disallowedExports && disallowedExports.indexOf(exportName) > -1;
  }
}

module.exports = function(babel) {
  const t = babel.types;
  // Flips the @ember-data/rfc395-data mapping into an 'import' indexed object, that exposes the
  // default import as well as named imports, e.g. import {foo} from 'bar'
  const reverseMapping = {};
  mapping.forEach(exportDefinition => {
    const imported = exportDefinition.global;
    const importRoot = exportDefinition.module;
    let importName = exportDefinition.export;

    if (!reverseMapping[importRoot]) {
      reverseMapping[importRoot] = {};
    }

    reverseMapping[importRoot][importName] = imported;

    if (exportDefinition.replacement) {
      let replacementPath = exportDefinition.replacement.module;
      let importName = exportDefinition.replacement.export;

      if (!reverseMapping[replacementPath]) {
        reverseMapping[replacementPath] = {};
      }

      reverseMapping[replacementPath][importName] = imported;
    }
  });

  let hasDSImport = false;
  let hasAnyDataImport = false;

  return {
    name: 'ember-data-packages-polyfill',
    visitor: {
      Program: {
        enter() {
          hasDSImport = false;
          hasAnyDataImport = false;
        },
        exit(path) {
          if (hasAnyDataImport && !hasDSImport) {
            // add `import DS from 'ember-data';`
            path.unshiftContainer(
              'body',
              t.ImportDeclaration(
                [t.ImportDefaultSpecifier(t.identifier('DS'))],
                t.stringLiteral('ember-data')
              )
            );
          }
        },
      },
      ImportDeclaration(path, state) {
        let disallowedList = (state.opts && state.opts.disallowedList) || [];
        let node = path.node;
        let replacements = [];
        let declarations = [];
        let removals = [];
        let specifiers = path.get('specifiers');
        let importPath = node.source.value;

        if (importPath === 'ember-data') {
          // For `import DS from 'ember-data'`, we do nothing
          let specifierPath = specifiers.find(specifierPath => {
            if (specifierPath.isImportDefaultSpecifier()) {
              hasDSImport = true;
              return true;
            }
            // TODO: Use the nice Babel way to throw
            throw new Error(`Unexpected non-default import from 'ember-data'`);
          });

          if (specifierPath) {
            let local = specifierPath.node.local;
            // we weren't named DS, we rename
            if (local.name !== 'DS') {
              replacements.push([
                local.name,
                'DS',
              ]);
              hasDSImport = false;
            }
          } else {
            removals.push(path);
          }
        }

        // This is the mapping to use for the import statement
        const mapping = reverseMapping[importPath];

        // Only walk specifiers if this is a module we have a mapping for
        if (mapping) {

          // Iterate all the specifiers and attempt to locate their mapping
          specifiers.forEach(specifierPath => {
            let specifier = specifierPath.node;
            let importName;

            // imported is the name of the module being imported, e.g. import foo from bar
            const imported = specifier.imported;

            // local is the name of the module in the current scope, this is usually the same
            // as the imported value, unless the module is aliased
            const local = specifier.local;

            // We only care about these 2 specifiers
            if (
              specifier.type !== 'ImportDefaultSpecifier' &&
              specifier.type !== 'ImportSpecifier'
            ) {
              if (specifier.type === 'ImportNamespaceSpecifier') {
                throw new Error(`Using \`import * as ${specifier.local} from '${importPath}'\` is not supported.`);
              }
              return;
            }

            // Determine the import name, either default or named
            if (specifier.type === 'ImportDefaultSpecifier') {
              importName = 'default';
            } else {
              importName = imported.name;
            }

            if (isDisallowed(disallowedList, importPath, importName)) {
              return;
            }

            // Extract the global mapping
            const global = mapping[importName];

            // Ensure the module being imported exists
            if (!global) {
              throw path.buildCodeFrameError(`${importPath} does not have a ${importName} export`);
            }
            hasAnyDataImport = true;

            removals.push(specifierPath);

            if (path.scope.bindings[local.name].referencePaths.find(rp => rp.parent.type === 'ExportSpecifier')) {
              // not safe to use path.scope.rename directly
              declarations.push(t.variableDeclaration('var', [
                t.variableDeclarator(
                  t.identifier(local.name),
                  t.identifier(global)
                ),
              ]));
            } else {
              // Replace the occurences of the imported name with the global name.
              replacements.push([
                local.name,
                global,
              ]);
            }
          });
        }

        if (replacements.length) {
          replacements.forEach(replacement => {
            let local = replacement[0];
            let global = replacement[1];
            path.scope.rename(local, global);
          });
        }

        if (removals.length > 0 || mapping) {
          if (removals.length === node.specifiers.length) {
            path.replaceWithMultiple(declarations);
          } else {
            removals.forEach(specifierPath => specifierPath.remove());
            if (declarations.length) {
              path.insertAfter(declarations);
            }
          }
        }
      },

      ExportNamedDeclaration(path, state) {
        let disallowedList = (state.opts && state.opts.disallowedList) || [];
        let node = path.node;
        if (!node.source) {
          return;
        }

        let replacements = [];
        let removals = [];
        let specifiers = path.get('specifiers');
        let importPath = node.source.value;

        // This is the mapping to use for the import statement
        const mapping = reverseMapping[importPath];

        // Only walk specifiers if this is a module we have a mapping for
        if (mapping) {
          hasAnyDataImport = true;

          // Iterate all the specifiers and attempt to locate their mapping
          specifiers.forEach(specifierPath => {
            let specifier = specifierPath.node;

            // exported is the name of the module being export,
            // e.g. `foo` in `export { computed as foo } from '@ember/object';`
            const exported = specifier.exported;

            // local is the original name of the module, this is usually the same
            // as the exported value, unless the module is aliased
            const local = specifier.local;

            // We only care about the ExportSpecifier
            if (specifier.type !== 'ExportSpecifier') {
              return;
            }

            // Determine the import name, either default or named
            let importName = local.name;

            if (isDisallowed(disallowedList, importPath, importName)) {
              return;
            }

            // Extract the global mapping
            const global = mapping[importName];

            // Ensure the module being imported exists
            if (!global) {
              throw path.buildCodeFrameError(`${importPath} does not have a ${importName} export`);
            }

            removals.push(specifierPath);

            let declaration;
            const globalAsIdentifier = t.identifier(global);
            if (exported.name === 'default') {
              declaration = t.exportDefaultDeclaration(
                globalAsIdentifier
              );
            } else {
              // Replace the node with a new `var name = Ember.something`
              declaration = t.exportNamedDeclaration(
                t.variableDeclaration('var', [
                  t.variableDeclarator(
                    exported,
                    globalAsIdentifier
                  ),
                ]),
                [],
                null
              );
            }
            replacements.push(declaration);

          });
        }

        if (removals.length > 0 && removals.length === node.specifiers.length) {
          path.replaceWithMultiple(replacements);
        } else if (replacements.length > 0) {
          removals.forEach(specifierPath => specifierPath.remove());
          path.insertAfter(replacements);
        }
      },

      ExportAllDeclaration(path) {
        let node = path.node;
        let importPath = node.source.value;

        // This is the mapping to use for the import statement
        const mapping = reverseMapping[importPath];

        // Only walk specifiers if this is a module we have a mapping for
        if (mapping) {
          throw path.buildCodeFrameError(`Wildcard exports from ${importPath} are currently not possible`);
        }
      },
    },
  };
};

// Provide the path to the package's base directory for caching with broccoli
// Ref: https://github.com/babel/broccoli-babel-transpiler#caching
module.exports.baseDir = () => path.resolve(__dirname, '..');
