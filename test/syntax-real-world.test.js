// Regression tests for syntax real dependabot.yml files use. Each case below
// was taken from a public repository whose config GitHub parses and runs today;
// rejecting any of them would turn a valid config into "your config is broken".

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsync, byCode } from './helpers.js';
import { parseYaml, mapGet, toPlain } from '../core/yaml.js';
import { canonicalUpdateType } from '../core/config.js';

const NPM_LOCK = (names) => ({
  lockfileVersion: 3,
  packages: Object.fromEntries([['', {}], ...names.map((name) => [`node_modules/${name}`, { version: '1.0.0' }])]),
});

test('a flow sequence indented under a key is a value, not a mapping (docsifyjs/docsify)', () => {
  const doc = parseYaml(`groups:
  patch-and-minor:
    update-types:
      ['version-update:semver-patch', 'version-update:semver-minor']
    patterns: ["*"]
`);
  const group = mapGet(mapGet(doc, 'groups'), 'patch-and-minor');
  assert.deepEqual(toPlain(mapGet(group, 'update-types')), ['version-update:semver-patch', 'version-update:semver-minor']);
});

test('bare major/minor/patch update-types are accepted, never an error (Fastjur repro)', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      aws:
        patterns:
          - "@aws-sdk/*"
      minor-and-patch-updates:
        dependency-type: "production"
        update-types: ["minor", "patch"]
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { '@apollo/client': '^4', '@aws-sdk/client-dynamodb': '^3' } },
    'package-lock.json': NPM_LOCK(['@apollo/client', '@aws-sdk/client-dynamodb', '@aws-sdk/core']),
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  const found = byCode(result, 'captured-by-score');
  assert.equal(found.length, 1, JSON.stringify(result.defects));
  assert.equal(found[0].target, 'aws');
  assert.equal(found[0].winner, 'minor-and-patch-updates');
  assert.deepEqual(found[0].scores, { this: 95, winner: 500 });
  assert.deepEqual(found[0].effective_update_types, ['minor', 'patch']);
  assert.equal(found[0].direct_matched_by_rule, 1);
  assert.equal(found[0].direct_total, 2);
  assert.match(found[0].detail, /Applies to minor and patch updates\./);
});

test('bare update-types in an ignore block are canonicalised internally, printed as written', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "*"
        update-types: ["minor", "patch"]
`,
    { 'package.json': { dependencies: { react: '^18' } }, 'package-lock.json': NPM_LOCK(['react']) },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.defects, []);
  assert.equal(canonicalUpdateType('minor'), 'version-update:semver-minor');
  assert.equal(canonicalUpdateType('version-update:semver-patch'), 'version-update:semver-patch');
});

test('flood risk is suppressed when every direct dependency ignores minor and patch', async () => {
  const deps = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`pkg-${i}`, '^1']));
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: daily
    ignore:
      - dependency-name: "*"
        update-types: ["minor", "patch"]
`,
    { 'package.json': { dependencies: deps }, 'package-lock.json': NPM_LOCK(Object.keys(deps)) },
  );
  assert.deepEqual(byCode(result, 'flood-risk'), []);
  assert.ok(result.skipped.some((item) => /only major updates/.test(item.reason)));
});

test('a dependency-type group does not capture a dependency of the other type', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      prod-specific:
        dependency-type: production
        patterns: ["react*"]
      dev-specific:
        dependency-type: development
        patterns: ["react*"]
`,
    {
      'package.json': { dependencies: { react: '^18' }, devDependencies: { 'react-test-renderer': '^18' } },
      'package-lock.json': NPM_LOCK(['react', 'react-test-renderer']),
    },
  );
  assert.deepEqual(result.defects, []);
});

test('comments and blank lines inside nested blocks keep line numbers honest (prisma-style ignore blocks)', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      # a long prose comment about why this pin exists
      # spanning several lines
      # and more
      - dependency-name: "typo-name"
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': NPM_LOCK(['react']),
  });
  const [found] = byCode(result, 'ignore-no-match');
  assert.equal(found.yml_line, 11, 'the dependency-name line, counted from the source');
});

test('the same group name in different entries is evaluated per entry', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    groups:
      minor:
        patterns: ["nope*"]
  - package-ecosystem: npm
    directory: "/packages/b"
    schedule:
      interval: weekly
    groups:
      minor:
        patterns: ["react*"]
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': NPM_LOCK(['react']),
    'packages/b/package.json': { dependencies: { react: '^18' } },
    'packages/b/package-lock.json': NPM_LOCK(['react']),
  });
  const found = byCode(result, 'no-op-group');
  assert.equal(found.length, 1, 'only the entry that matches nothing is reported');
  assert.equal(found[0].directory, '/');
});

test('a block sequence at the same indentation as its parent key parses (Dependabot template shape, cli/cli)', async () => {
  const config = `version: 2
updates:
- package-ecosystem: "npm"
  directory: "/"
  schedule:
    interval: "weekly"
  groups:
    react:
      patterns: ["react*"]
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': NPM_LOCK(['react']),
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.defects, []);
});

test('a leading document marker (---) is accepted (weppos/whois)', async () => {
  const config = `---
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': NPM_LOCK(['react']),
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('package-ecosystem: devcontainers (plural) is accepted (microsoft/vscode, containers.dev guide)', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: "devcontainers"
    directory: "/"
    schedule:
      interval: "weekly"
`,
    { '.devcontainer/devcontainer.json': '{ "image": "node:20" }' },
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.defects, []);
});

test('an empty patterns list is diagnosed as empty-patterns, with the catch-all warning', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      empty:
        patterns: []
`,
    { 'package.json': { dependencies: { react: '^18' } }, 'package-lock.json': NPM_LOCK(['react']) },
  );
  const [found] = byCode(result, 'no-op-group');
  assert.equal(found.why, 'empty-patterns');
  assert.match(found.suggestion, /deleting the key/i);
  assert.match(found.suggestion, /14576|catch-all/);
});

test('YAML anchors and aliases in schedule blocks (fixture f26)', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: &weekly
      interval: weekly
  - package-ecosystem: npm
    directory: "/web"
    schedule: *weekly
`,
    {
      'package.json': { dependencies: { react: '^18' } },
      'package-lock.json': NPM_LOCK(['react']),
      'web/package.json': { dependencies: { react: '^18' } },
      'web/package-lock.json': NPM_LOCK(['react']),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.defects, []);
  assert.deepEqual(result.entries.map((entry) => entry.schedule), ['weekly', 'weekly']);
});

test('YAML merge keys (<<) are resolved', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      <<: &base
        interval: monthly
`,
    { 'package.json': { dependencies: { react: '^18' } }, 'package-lock.json': NPM_LOCK(['react']) },
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.entries[0].schedule, 'monthly');
});
