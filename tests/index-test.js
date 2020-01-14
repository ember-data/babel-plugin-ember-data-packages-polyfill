'use strict';
/* globals QUnit */

const describe = QUnit.module;
const it = QUnit.test;
const babel = require('@babel/core');
const Plugin = require('../src');
const mapping = require('@ember-data/rfc395-data');

function transform(source, _plugins) {
  let plugins = _plugins || [
    [Plugin],
  ];
  let result = babel.transformSync(source, {
    plugins,
  });

  return result.code;
}

function matches(source, expected, only) {
  (only ? QUnit.only : it)(`${source}`, assert => {
    let actual = transform(source).replace(/\n/g,'');
    let realExpected = expected.replace(/\n/g,'');

    assert.equal(actual, realExpected);
  });
}

function testMatch(definition, global) {
  let importName = definition.export || 'default';
  let importRoot = definition.module;
  const varName = importName === 'default' ? 'defaultModule' : importName;
  const localName = varName === 'defaultModule' ? varName : `{ ${varName} }`;

  matches(
    `import ${localName} from '${importRoot}';var _x = ${varName}`,
    `import DS from "ember-data";var _x = ${global};`
  );
}

// Ensure each of the config mappings is mapped correctly
describe(`ember-data-packages-polyfill | Mappings`, () => {
  mapping.forEach(exportDefinition => {
    testMatch(exportDefinition, exportDefinition.global);

    if (exportDefinition.replacement) {
      testMatch(exportDefinition.replacement, exportDefinition.global);
    }
  });
});

// Ensure it works in complex scopes
describe(`ember-data-packages-polyfill | import-complex-scopes`, () => {
  matches(
    `import { attr } from '@ember-data/model';
var _x = someArray.every(item => attr(item));
var _y = someOtherArray.some((attr, idx) => attr(idx));`,
    `import DS from "ember-data";
var _x = someArray.every(item => DS.attr(item));
var _y = someOtherArray.some((attr, idx) => attr(idx));`
  );
});

// Ensure we don't insert an unnecessary import
describe(`ember-data-packages-polyfill | no-mapped-import`, () => {
  matches(
    `import Ember from 'ember';`,
    `import Ember from 'ember';`
  );
});

// Ensure mapping without reference just leaves us with the DS import
describe(`ember-data-packages-polyfill | import-without-reference`, () => {
  matches(
    `import Model, { attr } from '@ember-data/model';
import Adapter from '@ember-data/adapter';`,
    `import DS from "ember-data";`
  );
});

// Ensure mapping multiple imports makes multiple variables
describe(`ember-data-packages-polyfill | import-multiple`, () => {
  matches(
    `import Model, { attr, belongsTo } from '@ember-data/model';var _x = Model;var _y = attr;var _z = belongsTo;`,
    `import DS from "ember-data";var _x = DS.Model;var _y = DS.attr;var _z = DS.belongsTo;`
  );
});

// Ensure mapping a named aliased import
describe(`ember-data-packages-polyfill | named-as-alias`, () => {
  matches(
    `import { attr as DataAttr } from '@ember-data/model';var _x = DataAttr;`,
    `import DS from "ember-data";var _x = DS.attr;`
  );
});

// Ensure mapping a named and aliased import makes multiple named variables
describe(`ember-data-packages-polyfill | import-named-multiple`, () => {
  matches(
    `import { attr, belongsTo as foo } from '@ember-data/model';var _x = attr;var _y = foo;`,
    `import DS from "ember-data";var _x = DS.attr;var _y = DS.belongsTo;`
  );
});

// Ensure mapping the default as an alias works
describe(`ember-data-packages-polyfill:default-as-alias`, () => {
  matches(
    `import { default as foo } from '@ember/component';var _x = foo;`,
    `var _x = Ember.Component;`
  );
});

// Ensure reexporting things works
describe(`ember-data-packages-polyfill:reexport`, () => {
  matches(
    `export { default } from '@ember/component';`,
    `export default Ember.Component;`
  );

  matches(
    `export { default as Component } from '@ember/component';`,
    `export var Component = Ember.Component;`
  );

  matches(
    `export { computed } from '@ember/object';`,
    `export var computed = Ember.computed;`
  );

  matches(
    `export { computed as foo } from '@ember/object';`,
    `export var foo = Ember.computed;`
  );

  matches(
    `export var foo = 42;`,
    `export var foo = 42;`
  );

  it(`throws an error for wildcard imports`, assert => {
    let input = `import * as debug from '@ember/debug';`;

    assert.throws(() => {
      transform(input, [
        [Plugin],
      ]);
    }, 'Using `import * as debug from \'@ember/debug\'` is not supported');
  });

  it(`throws an error for wildcard exports`, assert => {
    let input = `export * from '@ember/object/computed';`;

    assert.throws(() => {
      transform(input, [
        [Plugin],
      ]);
    }, /Wildcard exports from @ember\/object\/computed are currently not possible/);
  });

  matches(
    `export * from 'foo';`,
    `export * from 'foo';`
  );
});

// Ensure unknown exports are not removed
describe(`unknown imports from known module`, () => {
  it(`allows blacklisting import paths`, assert => {
    let input = `import { derp } from '@ember/object/computed';`;

    assert.throws(() => {
      transform(input, [
        [Plugin],
      ]);
    }, /@ember\/object\/computed does not have a derp export/);
  });
});

describe(`import then export`, () => {
  matches(
    `import { capitalize } from '@ember/string';
export { capitalize };`,
    `var capitalize = Ember.String.capitalize;

export { capitalize };`
  );
  matches(
    `import { capitalize, camelize } from '@ember/string';
    camelize("a thing");
    capitalize("another thing");
    export { capitalize };`,
    `var capitalize = Ember.String.capitalize;

Ember.String.camelize("a thing");
capitalize("another thing");
export { capitalize };`
  );
});

describe('options', () => {
  describe('blacklist', () => {
    it(`allows blacklisting import paths`, assert => {
      let input = `import { assert } from '@ember/debug';`;
      let actual = transform(input, [
        [Plugin, { blacklist: ['@ember/debug'] }],
      ]);

      assert.equal(actual, input);
    });

    it(`allows blacklisting specific named imports`, assert => {
      let input = `import { assert, inspect } from '@ember/debug';var _x = inspect`;
      let actual = transform(input, [
        [Plugin, { blacklist: { '@ember/debug': ['assert', 'warn', 'deprecate'] } }],
      ]);

      assert.equal(actual, `import { assert } from '@ember/debug';var _x = Ember.inspect;`);
    });

    it('does not error when a blacklist is not present', assert => {
      let input = `import { assert, inspect } from '@ember/debug';var _x = assert; var _y = inspect;`;
      let actual = transform(input, [
        [Plugin, { blacklist: { } }],
      ]);

      assert.equal(actual, `var _x = Ember.assert;var _y = Ember.inspect;`);
    });
  });
});

describe(`import from 'ember'`, () => {
  matches(
    `import Ember from 'ember';var _x = Ember;`,
    `var _x = Ember;`
  );
  matches(
    `import Em from 'ember'; var _x = Em;`,
    `var _x = Ember;`
  );
  matches(
    `import Asdf from 'ember';var _x = Asdf;`,
    `var _x = Ember;`
  );
  matches(
    `import './foo';`,
    `import './foo';`
  );
});

describe(`import without specifier is removed`, () => {
  matches(
    `import 'ember';`,
    ``
  );
  matches(
    `import '@ember/component';`,
    ``
  );
});

