// Repository hygiene tests: these run on every OS in CI and encode two launch
// constraints that are trivial to break by accident.
//
//   1. Every committed text file is LF. The build machine has
//      core.autocrlf=true; without .gitattributes a CRLF blob lands in the
//      repository and the whole tree shows as modified.
//   2. Nothing under core/ imports a Node builtin — the core must stay
//      importable from a browser page.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'review', 'gate-cache']);

function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // the gate materialises real repositories here; they are not our sources
      if (relative(root, join(directory, entry.name)).replace(/\\/g, '/').startsWith('tools/gate')) continue;
      walk(join(directory, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(directory, entry.name));
    }
  }
  return out;
}

const files = walk(root);

test('all committed text files use LF, not CRLF', () => {
  const offenders = [];
  for (const file of files) {
    const name = file.slice(file.lastIndexOf(sep) + 1);
    if (/\.(png|jpg|jpeg|gif|ico|webp|pdf|zip|gz|woff2?|ttf|otf)$/i.test(name)) continue;
    if (/\.(bat|cmd|ps1)$/i.test(name)) continue;
    if (statSync(file).size > 2_000_000) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes('\r\n')) offenders.push(relative(root, file));
  }
  assert.deepEqual(offenders, []);
});

test('.gitattributes pins LF', () => {
  const text = readFileSync(join(root, '.gitattributes'), 'utf8');
  assert.match(text, /^\* text=auto eol=lf$/m);
});

test('core/ has no Node builtin imports (browser-importable)', () => {
  const offenders = [];
  for (const file of walk(join(root, 'core'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:') || specifier.startsWith('fs') || specifier.startsWith('path')) {
        offenders.push(`${relative(root, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the package declares a bin that exists and no runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies && Object.keys(pkg.dependencies).length, 0);
  const bin = pkg.bin['dependabot-doctor'];
  assert.ok(bin, 'package.json must declare a bin');
  assert.ok(statSync(join(root, bin)).isFile(), `bin target ${bin} must be committed`);
  assert.equal(pkg.type, 'module');
});

test('the config of this repository lints clean', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [join(root, 'bin', 'dependabot-doctor.js'), root, '--no-color'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
