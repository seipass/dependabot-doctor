import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsync, byCode, viewOf } from './helpers.js';
import { analyze } from '../core/analyze.js';
import { serialize, exitCodeFor } from '../core/report/json.js';
import { buildPatch } from '../core/report/patch.js';

const NPM_LOCK = (names) => ({
  lockfileVersion: 3,
  packages: Object.fromEntries([['', {}], ...names.map((name) => [`node_modules/${name}`, { version: '1.0.0' }])]),
});

test('a valid multi-ecosystem config produces zero findings and exit 0', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    groups:
      react:
        patterns: ["react*"]
    ignore:
      - dependency-name: "lodash"
  - package-ecosystem: docker
    directory: "/"
    schedule:
      interval: monthly
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
`,
    {
      'package.json': { dependencies: { react: '^18', 'react-dom': '^18', lodash: '^4' } },
      'package-lock.json': NPM_LOCK(['react', 'react-dom', 'lodash']),
      Dockerfile: 'FROM node:20-slim\nRUN true\n',
      '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n',
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.defects, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(exitCodeFor(result, 'all'), 0);
});

test('a group whose patterns match nothing is reported with the exact yml line', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      playwright:
        patterns: ["playwrite*"]
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': NPM_LOCK(['react']),
  });
  const [found] = byCode(result, 'no-op-group');
  assert.ok(found);
  assert.equal(found.why, 'zero-match');
  assert.equal(found.yml_line, 8);
  assert.equal(found.matched, 0);
  assert.equal(found.total, 1);
  assert.match(found.detail, /0 of 1 dependencies/);
  assert.equal(exitCodeFor(result, 'all'), 2);
});

test('an ignore rule that matches nothing is reported', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "lodahs"
      - dependency-name: "react"
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': NPM_LOCK(['react']),
  });
  const found = byCode(result, 'ignore-no-match');
  assert.equal(found.length, 1);
  assert.equal(found[0].target, 'lodahs');
  assert.equal(found[0].yml_line, 8);
  assert.equal(found[0].matched, 0);
});

test('NO LOCKFILE: findings are suppressed and a skip reason is emitted instead', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      testing:
        patterns: ["jest*"]
    ignore:
      - dependency-name: "typo"
`;
  const result = await runAsync(config, { 'package.json': { dependencies: { react: '^18' } } });
  assert.deepEqual(result.defects, [], 'a repo with no lockfile must not produce group/ignore findings');
  assert.ok(result.skipped.some((item) => /no lockfile committed/.test(item.reason)));
  assert.equal(exitCodeFor(result, 'all'), 0);
});

test('a directories glob that matches no directory is reported', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directories:
      - "/apps/*"
      - "/"
    schedule:
      interval: weekly
`;
  const result = await runAsync(config, { 'package.json': { dependencies: { react: '^18' } } });
  const found = byCode(result, 'directory-no-match');
  assert.equal(found.length, 1);
  assert.equal(found[0].target, '/apps/*');
  assert.equal(found[0].yml_line, 5);
});

test('a glob that does match a directory is not reported', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directories:
      - "/packages/*"
    schedule:
      interval: weekly
`;
  const result = await runAsync(config, {
    'packages/a/package.json': { dependencies: { react: '^18' } },
    'packages/a/package-lock.json': NPM_LOCK(['react']),
  });
  assert.deepEqual(byCode(result, 'directory-no-match'), []);
});

test('an ecosystem declared where no manifest exists is reported', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: docker
    directory: "/"
    schedule:
      interval: weekly
`;
  const result = await runAsync(config, { 'README.md': 'hello\n' });
  const found = byCode(result, 'ecosystem-absent');
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /no docker manifest exists/);
  assert.equal(found[0].yml_line, 3);
});

test('a manifest in a subdirectory suppresses ecosystem-absent (conservative)', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
`;
  const result = await runAsync(config, { 'web/package.json': { dependencies: { react: '^18' } } });
  assert.deepEqual(byCode(result, 'ecosystem-absent'), []);
});

test('python: PEP 503 normalisation lets an ignore rule match a differently-spelled dependency', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: pip
    directory: "/"
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "Zope_Interface"
`;
  const result = await runAsync(config, {
    'requirements.txt': 'zope-interface==5.0\nrequests>=2\n',
    'poetry.lock': '[[package]]\nname = "zope-interface"\nversion = "5.0"\n\n[[package]]\nname = "requests"\nversion = "2.31"\n',
  });
  assert.deepEqual(byCode(result, 'ignore-no-match'), []);
});

test('python: an ignore rule with a typo is reported once the lockfile is present', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: pip
    directory: "/"
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "reqeusts"
`;
  const result = await runAsync(config, {
    'requirements.txt': 'requests>=2\n',
    'poetry.lock': '[[package]]\nname = "requests"\nversion = "2.31"\n',
  });
  const found = byCode(result, 'ignore-no-match');
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /matches 0 of 1/);
});

test('go modules: go.sum completes the dependency set', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: gomod
    directory: "/"
    schedule:
      interval: weekly
    groups:
      aws:
        patterns: ["github.com/aws/*"]
`;
  const result = await runAsync(config, {
    'go.mod': 'module example.com/x\n\ngo 1.22\n\nrequire github.com/aws/aws-sdk-go-v2 v1.0.0\n',
    'go.sum': 'github.com/aws/aws-sdk-go-v2 v1.0.0 h1:abc=\ngithub.com/aws/aws-sdk-go-v2 v1.0.0/go.mod h1:abc=\n',
  });
  assert.deepEqual(result.defects, []);
});

test('go modules without go.sum: no group findings', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: gomod
    directory: "/"
    schedule:
      interval: weekly
    groups:
      aws:
        patterns: ["github.com/aws/*"]
`;
  const result = await runAsync(config, {
    'go.mod': 'module example.com/x\n\ngo 1.22\n\nrequire github.com/other/y v1.0.0\n',
  });
  assert.deepEqual(result.defects, []);
  assert.ok(result.skipped.some((item) => /go\.sum/.test(item.reason)));
});

test('cargo: Cargo.lock completes the dependency set, wildcards match crate names', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: cargo
    directory: "/"
    schedule:
      interval: weekly
    groups:
      serde:
        patterns: ["serde*"]
`;
  const result = await runAsync(config, {
    'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
    'Cargo.lock': '[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "serde_json"\nversion = "1.0.0"\n',
  });
  assert.deepEqual(result.defects, []);
});

test('docker: image names drop registry and tag, so ignore rules match', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: docker
    directory: "/"
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "node"
      - dependency-name: "ghcr.io/acme/tool"
`;
  const result = await runAsync(config, {
    Dockerfile: 'FROM node:20-slim AS build\nFROM ghcr.io/acme/tool:1.2.3\n',
  });
  assert.deepEqual(byCode(result, 'ignore-no-match'), []);
});

test('github actions: uses refs are dependencies, including owner/repo aliases', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    groups:
      actions:
        patterns: ["actions/*"]
    ignore:
      - dependency-name: "docker/build-push-action"
`;
  const result = await runAsync(config, {
    '.github/workflows/ci.yml':
      'jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: docker/build-push-action/sub@v5\n',
  });
  assert.deepEqual(result.defects, []);
});

test('flood risk fires on daily + ungrouped + capped PRs with many direct deps', async () => {
  const deps = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`pkg-${i}`, '^1']));
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: daily
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: deps },
    'package-lock.json': NPM_LOCK(Object.keys(deps)),
  });
  const found = byCode(result, 'flood-risk');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'info');
  assert.equal(found[0].matched, 30);
  // advisory only: does not fail the default run
  assert.equal(exitCodeFor(result, 'all'), 0);
  assert.equal(exitCodeFor(result, 'flood-risk'), 2);
});

test('flood risk stays quiet when a version-update group exists', async () => {
  const deps = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`pkg-${i}`, '^1']));
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: daily
    groups:
      all:
        patterns: ["pkg-*"]
`,
    { 'package.json': { dependencies: deps }, 'package-lock.json': NPM_LOCK(Object.keys(deps)) },
  );
  assert.deepEqual(byCode(result, 'flood-risk'), []);
});

test('dependency-type rules are skipped when production/development is unknowable', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    groups:
      dev:
        dependency-type: "development"
        patterns: ["*"]
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': NPM_LOCK(['react', 'transitive-only']),
  });
  assert.deepEqual(result.defects, []);
});

test('dependency-type: development is evaluated when the manifest tells us the type', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    groups:
      dev:
        dependency-type: "development"
        patterns: ["*"]
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' }, devDependencies: { typescript: '^5' } },
    'package-lock.json': NPM_LOCK(['react', 'typescript']),
  });
  assert.deepEqual(result.defects, []);
});

test('a groups block with dependency-type on an unsupported ecosystem is skipped, not reported', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: gomod
    directory: "/"
    schedule:
      interval: weekly
    groups:
      dev:
        dependency-type: "development"
        patterns: ["*"]
`;
  const result = await runAsync(config, {
    'go.mod': 'module x\n\ngo 1.22\n',
    'go.sum': 'github.com/a/b v1.0.0 h1:x=\n',
  });
  assert.deepEqual(result.defects, []);
  assert.ok(result.skipped.some((item) => /dependency-type/.test(item.reason)));
});

test('security-update-only groups are skipped with a reason', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    groups:
      security:
        applies-to: security-updates
        patterns: ["*"]
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': NPM_LOCK(['react']),
  });
  assert.deepEqual(result.defects, []);
  assert.ok(result.skipped.some((item) => /security updates only/.test(item.reason)));
});

test('unsupported ecosystems are skipped with an explicit reason', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: bundler
    directory: "/"
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "rails"
`;
  const result = await runAsync(config, { Gemfile: 'source "https://rubygems.org"\n' });
  assert.deepEqual(result.defects, []);
  assert.ok(result.skipped.some((item) => /not enumerable/.test(item.reason)));
});

test('invalid configs are errors (exit 1), not findings', () => {
  const view = viewOf({ 'package.json': {} });
  const result = analyze({
    configText: 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: src\n',
    view,
  });
  assert.equal(result.ok, false);
  assert.equal(exitCodeFor(result, 'all'), 1);
  assert.ok(result.errors.some((error) => /must start with "\/"/.test(error.message)));
  assert.ok(result.errors.some((error) => /missing required key "schedule"/.test(error.message)));
});

test('JSON payload is stable and complete', async () => {
  const result = await runAsync(
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      nope:
        patterns: ["nope*"]
`,
    { 'package.json': { dependencies: { react: '^18' } }, 'package-lock.json': NPM_LOCK(['react']) },
  );
  const payload = serialize(result);
  assert.deepEqual(
    ['version', 'root', 'file', 'entries', 'defects', 'findings', 'skipped', 'warnings', 'errors', 'summary', 'files'].every(
      (key) => key in payload,
    ),
    true,
  );
  const defect = payload.defects[0];
  for (const key of ['code', 'severity', 'ecosystem', 'directory', 'target', 'group', 'matched', 'total', 'detail', 'yml_line']) {
    assert.ok(key in defect, `defect is missing ${key}`);
  }
  assert.equal(defect.kind, defect.code);
  assert.equal(defect.line, defect.yml_line);
  assert.equal(JSON.stringify(payload).includes('_loc'), false, 'internal fields must not leak into --json');
  assert.ok(['no-op-group', 'captured-by-score', 'ignore-no-match', 'directory-no-match', 'ecosystem-absent', 'flood-risk'].includes(defect.code));
});

test('the suggested patch removes the group and its parent key when it is the only group', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      nope:
        patterns: ["nope*"]
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': NPM_LOCK(['react']),
  });
  const patch = buildPatch(config, result.defects, '.github/dependabot.yml');
  assert.ok(patch);
  assert.match(patch, /printed only/);
  assert.match(patch, /^-    groups:/m);
  assert.match(patch, /^-      nope:/m);
  assert.match(patch, /\n /, 'context lines are kept');
});

test('the suggested patch removes only the offending ignore item', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "react"
      - dependency-name: "typo"
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': NPM_LOCK(['react']),
  });
  const patch = buildPatch(config, result.defects, '.github/dependabot.yml');
  assert.ok(patch);
  assert.match(patch, /^-      - dependency-name: "typo"/m);
  assert.doesNotMatch(patch, /-      - dependency-name: "react"/m);
  assert.doesNotMatch(patch, /-    ignore:/m, 'the ignore key stays because one rule survives');
});

test('open-pull-requests-limit: 0 disables version updates, so no version-update findings', async () => {
  const deps = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`pkg-${i}`, '^1']));
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: daily
    open-pull-requests-limit: 0
    groups:
      nope:
        patterns: ["nope*"]
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: deps },
    'package-lock.json': NPM_LOCK(Object.keys(deps)),
  });
  assert.deepEqual(result.defects, [], 'security-only mode must not produce no-op-group or flood-risk');
  assert.ok(result.skipped.some((item) => /open-pull-requests-limit: 0/.test(item.reason)));
});

test('two no-pattern groups split by dependency-type are a 500/500 tie, not a capture', async () => {
  const config = `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    groups:
      runtime-deps:
        dependency-type: "production"
      dev-deps:
        dependency-type: "development"
`;
  const result = await runAsync(config, {
    'package.json': { dependencies: { react: '^18' }, devDependencies: { typescript: '^5' } },
    'package-lock.json': NPM_LOCK(['react', 'typescript']),
  });
  assert.deepEqual(result.defects, []);
});
