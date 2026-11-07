import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'dependabot-doctor.js');

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'dbd-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

test('--help and --version work with no repo and no network', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /dependabot-doctor \d+\.\d+\.\d+/);
  assert.match(help.stdout, /Exit codes/);

  const version = run(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('clean repository: exit 0, no findings', () => {
  const fixture = repo({
    '.github/dependabot.yml': `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      react:
        patterns: ["react*"]
`,
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/react': { version: '18.0.0' } } },
  });
  try {
    const result = run([fixture.root]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /matches at least one dependency/);
    assert.match(result.stdout, /Read 3 files\./);
  } finally {
    fixture.cleanup();
  }
});

test('findings: exit 2, the finding is printed with file:line', () => {
  const fixture = repo({
    '.github/dependabot.yml': `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "lodahs"
`,
    'package.json': { dependencies: { lodash: '^4' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' } } },
  });
  try {
    const result = run([fixture.root, '--no-color']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /lodahs/);
    assert.match(result.stdout, /matches 0 of 1 direct dependencies/);
    assert.match(result.stdout, /dependabot\.yml:8/);
    assert.doesNotMatch(result.stdout, /Suggested patch/, 'the patch is opt-in');
  } finally {
    fixture.cleanup();
  }
});

test('--json emits the documented contract', () => {
  const fixture = repo({
    '.github/dependabot.yml': `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      testing:
        patterns: ["jest*"]
`,
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/react': { version: '18.0.0' } } },
  });
  try {
    const result = run([fixture.root, '--json']);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(typeof payload.version, 'string');
    assert.equal(typeof payload.root, 'string');
    assert.ok(Array.isArray(payload.defects));
    assert.ok(Array.isArray(payload.skipped));
    assert.equal(payload.summary.groups_total, 1);
    assert.equal(payload.summary.groups_empty, 1);
    assert.equal(payload.defects[0].code, 'no-op-group');
    assert.equal(payload.defects[0].yml_line, 8);
    assert.equal(payload.exit, 2);
  } finally {
    fixture.cleanup();
  }
});

test('--fail-on none never fails the run', () => {
  const fixture = repo({
    '.github/dependabot.yml': `version: 2
updates:
  - package-ecosystem: docker
    directory: /
    schedule:
      interval: weekly
`,
    'README.md': 'x\n',
  });
  try {
    assert.equal(run([fixture.root, '--fail-on', 'none']).status, 0);
    assert.equal(run([fixture.root, '--fail-on', 'ecosystem-absent']).status, 2);
    assert.equal(run([fixture.root, '--fail-on', 'flood-risk']).status, 0);
  } finally {
    fixture.cleanup();
  }
});

test('missing config is a usage error (exit 1), not a finding', () => {
  const fixture = repo({ 'README.md': 'x\n' });
  try {
    const result = run([fixture.root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no \.github\/dependabot\.yml/);
  } finally {
    fixture.cleanup();
  }
});

test('an invalid config exits 1 and explains the line', () => {
  const fixture = repo({
    '.github/dependabot.yml': `version: 2
updates:
  - package-ecosystem: npm
    directory: src
    schedule:
      interval: sometimes
`,
    'package.json': {},
  });
  try {
    const result = run([fixture.root, '--json']);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.errors.length >= 2);
    assert.ok(payload.errors.some((error) => /must start with "\/"/.test(error.message)));
  } finally {
    fixture.cleanup();
  }
});

test('--config - reads the config from stdin', () => {
  const fixture = repo({
    'package.json': { dependencies: { react: '^18' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/react': { version: '18.0.0' } } },
  });
  try {
    const config = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n    ignore:\n      - dependency-name: "nope"\n';
    const result = spawnSync(process.execPath, [bin, fixture.root, '--config', '-', '--json'], {
      input: config,
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.defects[0].code, 'ignore-no-match');
  } finally {
    fixture.cleanup();
  }
});

test('output never contains non-ASCII by default (cp932 terminals)', () => {
  const fixture = repo({
    '.github/dependabot.yml': `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "lodahs"
`,
    'package.json': { dependencies: { lodash: '^4' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' } } },
  });
  try {
    const result = run([fixture.root, '--no-color']);
    // eslint-disable-next-line no-control-regex
    assert.equal(/[^\x00-\x7F]/.test(result.stdout), false);
  } finally {
    fixture.cleanup();
  }
});

test('running the tool does not modify the fixture', () => {
  const fixture = repo({
    '.github/dependabot.yml': `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "lodahs"
`,
    'package.json': { dependencies: { lodash: '^4' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' } } },
  });
  try {
    const before = run([fixture.root, '--json']).stdout;
    const after = run([fixture.root, '--json']).stdout;
    assert.equal(before, after);
    const config = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', join(fixture.root, '.github/dependabot.yml')], { encoding: 'utf8' });
    assert.match(config.stdout, /lodahs/, 'the config is untouched');
  } finally {
    fixture.cleanup();
  }
});

test('--patch prints a patch; the default output does not', () => {
  const fixture = repo({
    '.github/dependabot.yml': `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "lodahs"
`,
    'package.json': { dependencies: { lodash: '^4' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' } } },
  });
  try {
    const withPatch = run([fixture.root, '--patch']);
    assert.match(withPatch.stdout, /Suggested patch \(printed only - nothing was written\)/);
    assert.match(withPatch.stdout, /-      - dependency-name: "lodahs"/m);
    const withoutPatch = run([fixture.root]);
    assert.doesNotMatch(withoutPatch.stdout, /Suggested patch/);
  } finally {
    fixture.cleanup();
  }
});

test('the printed patch actually applies with git apply --check', () => {
  const fixture = repo({
    '.github/dependabot.yml': `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      nope:
        patterns: ["nope*"]
    ignore:
      - dependency-name: "lodahs"
`,
    'package.json': { dependencies: { lodash: '^4' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' } } },
  });
  try {
    const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (git.status !== 0) return; // no git on this machine: nothing to prove here
    spawnSync('git', ['init', '-q'], { cwd: fixture.root });
    const result = run([fixture.root, '--patch']);
    const patch = result.stdout.slice(result.stdout.indexOf('--- a/'));
    writeFileSync(join(fixture.root, 'fix.patch'), patch, 'utf8');
    const check = spawnSync('git', ['apply', '--check', 'fix.patch'], { cwd: fixture.root, encoding: 'utf8' });
    assert.equal(check.status, 0, `git apply --check failed: ${check.stderr}
---
${patch}`);
  } finally {
    fixture.cleanup();
  }
});
