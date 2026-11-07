#!/usr/bin/env node
// Mirror the released core into docs/js/vendor/, and inline the demo fixture.
//
// Why a mirror at all: the page must run the *same* matcher the CLI runs, not a
// second implementation. core/ imports nothing from Node (that is a property of
// the code, checked by tools/web/check-mirror.mjs), so the exact bytes the CLI
// executes are also valid browser ES modules. Copying them verbatim — rather
// than re-deriving them — is what makes "one function shared by CLI and page"
// true instead of aspirational.
//
// The copy is taken from a git *tag*, never from the working tree: the page is
// published against a specific release, and a dirty checkout on this machine is
// not that release. test/web-mirror.test.js fails if the mirror and the tag
// disagree, so drift is a red test rather than a silent fork.
//
// Usage:
//   node tools/web/sync-vendor.mjs [--ref v0.1.0] [--fixture <dir>]
//
// --fixture defaults to ../fixtures/demo-repro-c0f39de relative to the repo
// root (it lives in the workspace, outside this repository). The inlined copy
// is committed, so the published repository stays self-contained: the demo
// works with no network and no third-party repo.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

// An untagged release cannot be described by a tag, and inventing one is how ref,
// commit, tag_object and tree diverged on v0.1.5. --from-head records the commit
// under test (HEAD) and says tag_object is null, so a record can never spell an
// untagged release with a plausible previous tag's identity.
const fromHead = args.includes('--from-head');
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const ref = argOf('ref', fromHead ? `v${version}` : 'v0.1.0');
const fixtureDir = argOf('fixture', join(repoRoot, '..', '..', 'fixtures', 'demo-repro-c0f39de'));
const vendorRoot = join(repoRoot, 'docs', 'js', 'vendor');

const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' });
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

if (!existsSync(join(repoRoot, '.git'))) {
  console.error('sync-vendor: no .git here; the mirror must come from a tag, not a directory');
  process.exit(1);
}

let release;
const source = fromHead ? 'HEAD' : ref;
try {
  release = fromHead
    ? {
        ref,
        commit: git('rev-parse', 'HEAD^{commit}').trim(),
        tag_object: null,
        tree: git('rev-parse', 'HEAD^{tree}').trim(),
        subject: git('log', '-1', '--format=%s', 'HEAD').trim(),
        source: 'HEAD at generation time; the tag is cut on this commit after the gates pass',
      }
    : {
        ref,
        commit: git('rev-parse', `${ref}^{commit}`).trim(),
        tag_object: (() => {
          try {
            return git('rev-parse', `${ref}^{commit}^{tag}`).trim();
          } catch {
            return null;
          }
        })(),
        tree: git('rev-parse', `${ref}^{tree}`).trim(),
        subject: git('log', '-1', '--format=%s', `${ref}^{commit}`).trim(),
      };
} catch (error) {
  console.error(`sync-vendor: cannot resolve ${ref}: ${error.message.split(String.fromCharCode(10))[0]}`);
  process.exit(2);
}

// ---- core/**/*.js ---------------------------------------------------------
const coreFiles = git('ls-tree', '-r', '--name-only', source, 'core')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.endsWith('.js'));
if (coreFiles.length === 0) {
  console.error(`sync-vendor: ${ref} has no core/*.js — wrong ref?`);
  process.exit(2);
}

rmSync(vendorRoot, { recursive: true, force: true });
const files = {};
for (const path of coreFiles) {
  const text = execFileSync('git', ['show', `${source}:${path}`], { cwd: repoRoot, encoding: 'utf8' });
  const target = join(vendorRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  files[path] = { sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') };
}

// ---- demo fixture, inlined ------------------------------------------------
// The button must survive the third-party repo disappearing. The copy spec
// allows an inlined fallback; inlining *all three* files means the fallback can
// still produce the frozen finding instead of degrading to "nothing to check".
const DEMO_REPO = 'Fastjur/dependabot-group-specificity-repro';
const DEMO_SHA = 'c0f39dec5e2763707c6ff5abdb7f18d88383ea0f';
const DEMO_FILES = ['.github/dependabot.yml', 'package.json', 'package-lock.json'];
const demo = { repo: DEMO_REPO, sha: DEMO_SHA, taken: '2026-11-07', files: {} };
for (const path of DEMO_FILES) {
  const absolute = join(fixtureDir, ...path.split('/'));
  if (!existsSync(absolute)) {
    console.error(`sync-vendor: demo fixture missing ${absolute}`);
    process.exit(2);
  }
  const text = readFileSync(absolute, 'utf8');
  demo.files[path] = { sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8'), text };
}

const demoSource = [
  '// GENERATED by tools/web/sync-vendor.mjs — do not edit by hand.',
  `// Verbatim bytes of ${DEMO_REPO} at ${DEMO_SHA}, taken ${demo.taken}.`,
  '// Loaded only when the visitor asks for the example, so the first paint does',
  '// not pay for the lockfile. sha256 per file is checked by test/web-mirror.test.js.',
  `export const DEMO = ${JSON.stringify(demo, null, 2)};`,
  '',
].join('\n');
writeFileSync(join(repoRoot, 'docs', 'js', 'demo-fixture.js'), demoSource);

// ---- release record -------------------------------------------------------
const record = {
  ...release,
  generated: new Date().toISOString(),
  note: 'docs/js/vendor/ is a byte-identical mirror of this ref. Regenerate with tools/web/sync-vendor.mjs.',
  core_files: files,
  demo: { repo: DEMO_REPO, sha: DEMO_SHA, taken: demo.taken, files: Object.fromEntries(Object.entries(demo.files).map(([p, v]) => [p, { sha256: v.sha256, bytes: v.bytes }])) },
};
writeFileSync(join(vendorRoot, 'RELEASE.json'), `${JSON.stringify(record, null, 2)}\n`);

console.log(`mirrored ${coreFiles.length} core files from ${ref} (${release.commit.slice(0, 7)})`);
console.log(`inlined ${DEMO_FILES.length} demo files (${Object.values(demo.files).reduce((sum, f) => sum + f.bytes, 0)} B)`);
for (const path of readdirSync(vendorRoot).sort()) console.log(`  docs/js/vendor/${path}`);
