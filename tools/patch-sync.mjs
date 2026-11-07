import { readFileSync, writeFileSync } from 'node:fs';
const p = new URL('../tools/web/sync-vendor.mjs', import.meta.url);
let s = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// 1) --from-head: record the commit being released, never a previous tag's identity
s = s.replace(
  `const ref = argOf('ref', 'v0.1.0');`,
  String.raw`// An untagged release cannot be described by a tag, and inventing one is how ref,
// commit, tag_object and tree diverged on v0.1.5. --from-head records the commit
// under test (HEAD) and says tag_object is null, so a record can never spell an
// untagged release with a plausible previous tag's identity.
const fromHead = args.includes('--from-head');
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const ref = argOf('ref', fromHead ? `v${version}` : 'v0.1.0');`,
);

s = s.replace(
  String.raw`let release;
try {
  release = {
    ref,
    commit: git('rev-parse', ` + '`${ref}^{commit}`' + String.raw`).trim(),
    tag_object: (() => {
      try {
        return git('rev-parse', ref).trim();
      } catch {
        return null;
      }
    })(),
    tree: git('rev-parse', ` + '`${ref}^{tree}`' + String.raw`).trim(),
    subject: git('log', '-1', '--format=%s', ` + '`${ref}^{commit}`' + String.raw`).trim(),
  };
} catch (error) {
  console.error(` + '`sync-vendor: cannot resolve ${ref}: ${error.message.split(\'\n\')[0]}`' + String.raw`);
  process.exit(2);
}`,
  String.raw`let release;
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
        commit: git('rev-parse', ` + '`${ref}^{commit}`' + String.raw`).trim(),
        tag_object: git('rev-parse', ` + '`${ref}^{commit}^{tag}`' + String.raw`).trim() || null,
        tree: git('rev-parse', ` + '`${ref}^{tree}`' + String.raw`).trim(),
        subject: git('log', '-1', '--format=%s', ` + '`${ref}^{commit}`' + String.raw`).trim(),
      };
} catch (error) {
  console.error(` + '`sync-vendor: cannot resolve ${ref}: ${String(error.message).split(\'\n\')[0]}`' + String.raw`);
  process.exit(2);
}`,
);

// 2) read the tree from the recorded source, not from a tag that may not exist
s = s.replace("const coreFiles = git('ls-tree', '-r', '--name-only', ref, 'core')",
              "const coreFiles = git('ls-tree', '-r', '--name-only', source, 'core')");
s = s.replace("const text = execFileSync('git', ['show', `${ref}:${path}`]",
              "const text = execFileSync('git', ['show', `${source}:${path}`]");

// 3) usage text
s = s.replace("//   node tools/web/sync-vendor.mjs [--ref v0.1.0] [--fixture <dir>]",
              "//   node tools/web/sync-vendor.mjs --from-head [--fixture <dir>]\n//   node tools/web/sync-vendor.mjs --ref v0.1.0 [--fixture <dir>]");
writeFileSync(p, s);
console.log('sync-vendor patched');
