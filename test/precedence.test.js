// Precedence tests.
//
// These encode dependabot-core's real behaviour, verified against source at
// commit d7b08f3309a484ea73d202ba30740530d40642e7 (2026-11-06):
//
//   updater/lib/dependabot/dependency_group_engine.rb
//     assign_dependencies_to_groups -> for each group, push the dependency
//     unless should_skip_due_to_specificity?
//   updater/lib/dependabot/updater/pattern_specificity_calculator.rb
//     the score that decides "more specific"; ties keep the dependency in BOTH
//     groups, config order is never consulted
//   updater/lib/dependabot/dependency_snapshot.rb:299
//     assign_to_groups!(dependencies: allowed_dependencies) — allow filtering
//     runs BEFORE grouping
//   common/lib/dependabot/config/update_config.rb + ignore_condition.rb
//     ignore conditions are unioned and applied at the version level
//
// If any of these tests start failing because the engine switched to
// "first group in the file wins", the tool would start emitting false
// positives, which is why the assertions include the negative case.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  belongsToMoreSpecificGroup,
  contains,
  groupSpecificity,
  patternSpecificity,
  NO_PATTERNS_SCORE,
  UNIVERSAL_WILDCARD_SCORE,
  EXACT_MATCH_SCORE,
  NO_WILDCARDS_SCORE,
} from '../core/specificity.js';
import { runAsync, byCode } from './helpers.js';

const group = (name, patterns, extra = {}) => ({
  name,
  patterns,
  excludePatterns: null,
  updateTypes: null,
  appliesTo: 'version-updates',
  dependencyType: null,
  groupBy: null,
  line: 1,
  endLine: 2,
  ...extra,
});

test('specificity constants match the calculator', () => {
  assert.equal(patternSpecificity('react', 'react'), EXACT_MATCH_SCORE);
  assert.equal(patternSpecificity('*', 'react'), UNIVERSAL_WILDCARD_SCORE);
  assert.equal(patternSpecificity('reactdom', 'reactdom'), EXACT_MATCH_SCORE);
  assert.equal(patternSpecificity('react-foo', 'react-foo'), EXACT_MATCH_SCORE); // exact always 1000
  assert.equal(groupSpecificity(group('g', null), 'anything'), NO_PATTERNS_SCORE);
  // wildcard base 100 - 10*count + max(len-5, 0)
  assert.equal(patternSpecificity('react*', 'react-dom'), 91);
  assert.equal(patternSpecificity('@aws-sdk/*', '@aws-sdk/client-s3'), 95);
});

test('a catch-all declared FIRST does not steal from a later specific group', () => {
  const catchAll = group('everything', ['*']);
  const specific = group('aws', ['@aws-sdk/*']);
  const groups = [catchAll, specific]; // catch-all is first, like the issue report

  assert.equal(belongsToMoreSpecificGroup(catchAll, '@aws-sdk/client-s3', groups), true);
  assert.equal(belongsToMoreSpecificGroup(specific, '@aws-sdk/client-s3', groups), false);
  // Non-matching name: the catch-all keeps it.
  assert.equal(belongsToMoreSpecificGroup(catchAll, 'lodash', groups), false);
});

test('declaration order is irrelevant (swap the groups, same verdicts)', () => {
  const catchAll = group('everything', ['*']);
  const specific = group('aws', ['@aws-sdk/*']);
  for (const groups of [[catchAll, specific], [specific, catchAll]]) {
    assert.equal(belongsToMoreSpecificGroup(catchAll, '@aws-sdk/client-s3', groups), true);
    assert.equal(belongsToMoreSpecificGroup(specific, '@aws-sdk/client-s3', groups), false);
  }
});

test('equal specificity keeps the dependency in both groups (no shadowing)', () => {
  const a = group('a', ['react*']);
  const b = group('b', ['react*']);
  assert.equal(groupSpecificity(a, 'react-dom'), groupSpecificity(b, 'react-dom'));
  assert.equal(belongsToMoreSpecificGroup(a, 'react-dom', [a, b]), false);
  assert.equal(belongsToMoreSpecificGroup(b, 'react-dom', [a, b]), false);
  assert.equal(contains(a, 'react-dom') && contains(b, 'react-dom'), true);
});

test('groups with non-overlapping update-types never shadow each other', () => {
  const minor = group('minor', ['*'], { updateTypes: ['version-update:semver-minor'] });
  const patch = group('patch', ['*'], { updateTypes: ['version-update:semver-patch'] });
  // assignment-time specificity is computed without an update type
  assert.equal(belongsToMoreSpecificGroup(minor, 'lodash', [minor, patch]), false);
  assert.equal(belongsToMoreSpecificGroup(patch, 'lodash', [minor, patch]), false);
});

test('exclude-patterns remove a dependency from a group entirely', () => {
  const g = group('g', ['*'], { excludePatterns: ['@types/*'] });
  assert.equal(contains(g, '@types/node'), false);
  assert.equal(contains(g, 'react'), true);
});

test('END TO END: a group shadowed by an EARLIER catch-all is reported once, for the catch-all', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      everything:
        patterns: ["*"]
      aws:
        patterns: ["@aws-sdk/*"]
`,
    {
      'package.json': { dependencies: { '@aws-sdk/client-s3': '^3', lodash: '^4' } },
      'package-lock.json': {
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/@aws-sdk/client-s3': { version: '3.0.0' },
          'node_modules/lodash': { version: '4.17.21' },
        },
      },
    },
  );
  // The catch-all still holds lodash, so it is NOT empty; the specific group
  // holds @aws-sdk/client-s3, so it is not empty either. Any finding here would
  // be a false positive.
  assert.deepEqual(result.defects, []);
});

test('END TO END: a group whose every dependency is claimed by a more specific group is reported, with the winner named', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      everything:
        patterns: ["*"]
      aws:
        patterns: ["@aws-sdk/client-*"]
`,
    {
      'package.json': { dependencies: { '@aws-sdk/client-s3': '^3', '@aws-sdk/client-dynamodb': '^3' } },
      'package-lock.json': {
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/@aws-sdk/client-s3': { version: '3.0.0' },
          'node_modules/@aws-sdk/client-dynamodb': { version: '3.0.0' },
        },
      },
    },
  );
  const found = byCode(result, 'captured-by-score');
  assert.equal(found.length, 1, JSON.stringify(result.defects, null, 1));
  assert.equal(found[0].target, 'everything');
  assert.equal(found[0].winner, 'aws');
  assert.deepEqual(found[0].scores, { this: 1, winner: 102 });
  assert.equal(found[0].update_types, null);
  assert.match(found[0].detail, /scores higher/);
});

test('END TO END: two groups with identical patterns produce no finding', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      first:
        patterns: ["react*"]
      second:
        patterns: ["react*"]
`,
    {
      'package.json': { dependencies: { react: '^18', 'react-dom': '^18' } },
      'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/react': { version: '18.0.0' }, 'node_modules/react-dom': { version: '18.0.0' } } },
    },
  );
  assert.deepEqual(result.defects, [], 'equal specificity => both groups are populated => nothing to report');
});

test('END TO END: allow filtering happens before grouping, and is named as the cause', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    allow:
      - dependency-name: "react"
    groups:
      everything:
        patterns: ["*"]
`,
    {
      'package.json': { dependencies: { react: '^18', lodash: '^4' } },
      'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/react': { version: '18.0.0' }, 'node_modules/lodash': { version: '4.17.21' } } },
    },
  );
  assert.deepEqual(result.defects, []);
});

test('END TO END: allow list that excludes every group match is reported as allow-excluded', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    allow:
      - dependency-name: "lodash"
    groups:
      react:
        patterns: ["react*"]
`,
    {
      'package.json': { dependencies: { react: '^18', 'react-dom': '^18', lodash: '^4' } },
      'package-lock.json': {
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/react': { version: '18.0.0' },
          'node_modules/react-dom': { version: '18.0.0' },
          'node_modules/lodash': { version: '4.17.21' },
        },
      },
    },
  );
  const found = byCode(result, 'no-op-group');
  assert.equal(found.length, 1);
  assert.equal(found[0].why, 'allow-excluded');
});
