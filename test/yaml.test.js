import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError, mapGet, toPlain } from '../core/yaml.js';

test('parses the shape dependabot.yml is written in', () => {
  const doc = parseYaml(`version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      minor:
        patterns:
          - "react*"
          - "@types/*"
        update-types: ["version-update:semver-minor"]
`);
  assert.equal(mapGet(doc, 'version').value, 2);
  const updates = mapGet(doc, 'updates');
  assert.equal(updates.type, 'seq');
  assert.equal(updates.items.length, 1);
  const entry = updates.items[0].value;
  assert.equal(mapGet(entry, 'package-ecosystem').value, 'npm');
  assert.deepEqual(toPlain(mapGet(mapGet(entry, 'groups'), 'minor')), {
    patterns: ['react*', '@types/*'],
    'update-types': ['version-update:semver-minor'],
  });
});

test('keeps line numbers on keys and values', () => {
  const doc = parseYaml(`version: 2
updates:
  - package-ecosystem: npm
    directory: /
    ignore:
      - dependency-name: "lodahs"
`);
  const entry = mapGet(doc, 'updates').items[0].value;
  const ignore = mapGet(entry, 'ignore');
  assert.equal(ignore.type, 'seq');
  assert.equal(ignore.items[0].line, 6);
  assert.equal(mapGet(entry, 'directory').line, 4);
});

test('strips comments but not inside quotes', () => {
  const doc = parseYaml(`version: 2  # top
updates:
  - directory: "/a#b"
    label: 'x # y'
`);
  const entry = mapGet(doc, 'updates').items[0].value;
  assert.equal(mapGet(entry, 'directory').value, '/a#b');
  assert.equal(mapGet(entry, 'label').value, 'x # y');
});

test('multi-line flow sequences are one logical line', () => {
  const doc = parseYaml(`updates:
  - patterns: [
      "react*",
      "vue*" ]
`);
  const entry = mapGet(doc, 'updates').items[0].value;
  assert.deepEqual(toPlain(mapGet(entry, 'patterns')), ['react*', 'vue*']);
});

test('flow maps, plain scalars, booleans and nulls', () => {
  const doc = parseYaml(`a: {x: 1, y: "two"}
b: true
c: ~
d: 07
e: hello world
`);
  assert.deepEqual(toPlain(doc), { a: { x: 1, y: 'two' }, b: true, c: null, d: 7, e: 'hello world' });
});

test('records duplicate keys instead of silently overwriting', () => {
  const doc = parseYaml('a: 1\na: 2\n');
  assert.deepEqual(doc.duplicateKeys, ['a']);
});

test('rejects tab indentation with the line number', () => {
  assert.throws(
    () => parseYaml('updates:\n\t- npm\n'),
    (error) => error instanceof YamlError && /tab character/.test(error.message) && error.line === 2,
  );
});

test('anchors and aliases resolve; unknown aliases are reported', () => {
  const doc = parseYaml('a: &x 1\nb: *x\n');
  assert.deepEqual(toPlain(doc), { a: 1, b: 1 });
  assert.throws(() => parseYaml('b: *missing\n'), /unknown YAML alias/);
});

test('rejects tags and block scalars instead of guessing', () => {
  assert.throws(() => parseYaml('a: !!str 1\n'), /tags are not supported/);
  assert.throws(() => parseYaml('a: |\n  text\n'), /block scalars/);
});

test('rejects unterminated flow collections', () => {
  assert.throws(() => parseYaml('a: [1, 2\n'), /unterminated flow collection/);
});

test('rejects unexpected indentation rather than mis-parsing', () => {
  assert.throws(() => parseYaml('updates:\n  - npm\n   stray: 1\n'), /unexpected indentation/);
});
