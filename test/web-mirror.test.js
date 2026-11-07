// Page parity and mirror integrity.
//
// The page runs the released core from docs/js/vendor/, which is a byte copy of
// a git tag. These tests fail when any of the following becomes untrue:
//
//   * the mirror and the tag disagree (someone edited the copy, or the tag moved)
//   * the mirror is missing a file the page imports (a hash-only check would pass)
//   * the page pipeline stops reproducing the frozen demo output in
//     launch/page-copy.md §3d — the one finding that is quoted at a stranger
//   * the probe table no longer covers a file name a collector opens
//   * the page gains a storage API, which would falsify "Nothing is stored."
//
// Nothing here touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyseText } from '../docs/js/check.js';
import { planReads, PROBE_FILES } from '../docs/js/probe-plan.js';
import { parseConfig } from '../docs/js/vendor/core/config.js';
import { DEMO } from '../docs/js/demo-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const docs = join(root, 'docs');
const vendor = join(docs, 'js', 'vendor');
const release = JSON.parse(readFileSync(join(vendor, 'RELEASE.json'), 'utf8'));
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const hasGit = () => {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

test('mirror matches the release record it was built from', () => {
  assert.ok(release.ref, 'RELEASE.json must name the ref it was built from');
  for (const [path, meta] of Object.entries(release.core_files)) {
    const absolute = join(vendor, path);
    assert.ok(existsSync(absolute), `mirrored file missing: ${path}`);
    assert.equal(sha256(readFileSync(absolute)), meta.sha256, `mirrored file edited by hand: ${path}`);
  }
  // No extras: a stale file left behind by an older ref would still be shipped.
  const onDisk = listFiles(vendor)
    .map((path) => relative(vendor, path).replace(/\\/g, '/'))
    .filter((path) => path.endsWith('.js'));
  assert.deepEqual(onDisk.sort(), Object.keys(release.core_files).sort());
});

test('mirror matches the tag, not the working tree', { skip: !hasGit() && 'git not available' }, () => {
  for (const path of Object.keys(release.core_files)) {
    const tagged = execFileSync('git', ['show', `${release.ref}:${path}`], { cwd: root, encoding: 'buffer' });
    assert.equal(
      sha256(tagged),
      release.core_files[path].sha256,
      `${path}: the page is pinned to ${release.ref}, but that tag no longer holds these bytes. ` +
        'Re-run tools/web/sync-vendor.mjs --ref <tag> only after the release it should match is decided.',
    );
  }
});

test('every module the page imports exists (content, not just hashes)', () => {
  const seen = new Set();
  const queue = [join(docs, 'js', 'app.js')];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(existsSync(file), `imported module missing: ${relative(root, file)}`);
    const source = readFileSync(file, 'utf8');
    for (const specifier of relativeImports(source)) {
      queue.push(join(dirname(file), specifier));
    }
  }
  // The page must not depend on anything outside docs/.
  for (const file of seen) {
    assert.ok(!relative(root, file).startsWith('..'), `${file} is outside the published directory`);
  }
  assert.ok(seen.size > 20, 'module graph looks truncated');
});

test('the page cannot emit a patch or a diff', () => {
  for (const path of ['app.js', 'check.js', 'report.js', 'view.js', 'demo.js', 'probe-plan.js', 'github.js']) {
    const source = readFileSync(join(docs, 'js', path), 'utf8');
    assert.ok(!/\bbuildPatch\b/.test(source), `${path} must never build a patch`);
    assert.ok(!/\bgit apply\b/.test(source), `${path} must never mention git apply`);
    assert.ok(!/patch:\s*true/.test(source), `${path} must not enable the patch option`);
  }
});

test('nothing is stored: no storage API anywhere in the published scripts', () => {
  for (const file of listFiles(join(docs, 'js'))) {
    // Comments are stripped first: the code is allowed to *document* that it
    // does not use these APIs, and it does, deliberately.
    const source = stripComments(readFileSync(file, 'utf8'));
    const name = relative(root, file);
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'navigator.sendBeacon']) {
      assert.ok(!source.includes(api), `${name} uses ${api}, which falsifies "Nothing is stored."`);
    }
  }
});

test('page pipeline reproduces the frozen demo output exactly', () => {
  const files = new Map(Object.entries(DEMO.files).map(([path, file]) => [path, file.text]));
  const report = analyseText(files.get('.github/dependabot.yml'), files);

  assert.deepEqual(report.verdict, ['1 group matched, but lost its dependency to a higher-scoring group.']);
  // The "Read N files." sentence is stripped on purpose (a94); the manifest
  // count is derived from the fetch list, never typed.
  assert.equal(report.count, 'Checked 1 npm manifest.');
  assert.deepEqual(report.skips, []);
  assert.equal(
    report.findings,
    [
      'aws                       1 of 2 direct dependencies matched, then lost',
      '                          to minor-and-patch-updates              dependabot.yml:9',
      '  @aws-sdk/client-dynamodb matches @aws-sdk/* (scores 95) and was assigned to',
      '  minor-and-patch-updates, which declares no patterns (scores 500).',
      '  Applies to minor and patch updates.',
    ].join('\n'),
  );
});

test('inlined demo fixture still carries the pinned bytes', () => {
  assert.equal(DEMO.sha, 'c0f39dec5e2763707c6ff5abdb7f18d88383ea0f');
  for (const [path, file] of Object.entries(DEMO.files)) {
    assert.equal(sha256(Buffer.from(file.text, 'utf8')), file.sha256, `demo fixture changed: ${path}`);
    assert.equal(Buffer.byteLength(file.text, 'utf8'), file.bytes, `demo fixture size changed: ${path}`);
  }
  assert.equal(DEMO.files['.github/dependabot.yml'].bytes, 417);
});

test('probe table covers every file name a collector opens', () => {
  const sources = {
    npm: readFileSync(join(root, 'core', 'deps', 'npm.js'), 'utf8'),
    pip: readFileSync(join(root, 'core', 'deps', 'python.js'), 'utf8'),
    uv: readFileSync(join(root, 'core', 'deps', 'python.js'), 'utf8'),
    gomod: readFileSync(join(root, 'core', 'deps', 'gomod.js'), 'utf8'),
    cargo: readFileSync(join(root, 'core', 'deps', 'cargo.js'), 'utf8'),
    docker: readFileSync(join(root, 'core', 'deps', 'docker.js'), 'utf8'),
    'github-actions': readFileSync(join(root, 'core', 'deps', 'actions.js'), 'utf8'),
  };
  for (const [ecosystem, source] of Object.entries(sources)) {
    const names = literalReads(source);
    const table = new Set(PROBE_FILES[ecosystem] ?? []);
    for (const name of names) {
      assert.ok(
        table.has(name),
        `${ecosystem}: core reads "${name}" by name, but docs/js/probe-plan.js does not probe for it`,
      );
    }
  }
});

test('a glob config asks for a listing instead of guessing', () => {
  const config = parseConfig(
    ['version: 2', 'updates:', '  - package-ecosystem: npm', '    directories: ["/packages/*"]', '    schedule:', '      interval: weekly', ''].join('\n'),
  );
  const plan = planReads(config.entries);
  assert.equal(plan.needsListing, true);
  assert.deepEqual(plan.paths, []);
});

// --- helpers ---------------------------------------------------------------

function listFiles(directory) {
  const out = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function relativeImports(source) {
  const out = [];
  const patterns = [/from\s+'(\.\.?\/[^']+)'/g, /import\s*\(\s*'(\.\.?\/[^']+)'\s*\)/g, /import\s+'(\.\.?\/[^']+)'/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]);
  }
  return out;
}

/** File names a collector passes to ctx.readIn/readAt, plus its own constants. */
function literalReads(source) {
  const names = new Set();
  for (const match of source.matchAll(/read(?:In|At)\(\s*directory\s*,\s*'([^']+)'/g)) names.add(match[1]);
  for (const match of source.matchAll(/\bfile:\s*'([^']+)'/g)) names.add(match[1]);
  for (const match of source.matchAll(/const\s+(?:MANIFEST|LOCK)\s*=\s*'([^']+)'/g)) names.add(match[1]);
  return [...names];
}

/** Remove line and block comments so documentation cannot fail a source scan. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
