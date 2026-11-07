// The worked example (page-copy.md §3d).
//
// Pinned to a commit, never to HEAD: a third-party repository must not be able
// to change under us and turn a working demo into "all clean".
//
// Live first, so the visitor's network tab shows the same thing the page claims.
// If any of the three files cannot be read, fall back to the inlined copy under
// docs/js/demo-fixture.js (loaded on demand, so the first paint does not pay for
// a 58 KB lockfile) and say plainly that it is a cached copy.

import { analyseText } from './check.js';
import { rawFile } from './github.js';

const DEMO = {
  owner: 'Fastjur',
  repo: 'dependabot-group-specificity-repro',
  sha: 'c0f39dec5e2763707c6ff5abdb7f18d88383ea0f',
  taken: '2026-11-07',
  config: '.github/dependabot.yml',
  files: ['.github/dependabot.yml', 'package.json', 'package-lock.json'],
};

export async function checkDemo({ signal } = {}) {
  const live = new Map();
  let complete = true;
  for (const path of DEMO.files) {
    const result = await rawFile({ owner: DEMO.owner, repo: DEMO.repo, ref: DEMO.sha, path, signal });
    if (result.kind !== 'ok') {
      complete = false;
      break;
    }
    live.set(path, result.text);
  }

  if (complete) {
    return { report: analyseText(live.get(DEMO.config), live), origin: 'live', notice: null };
  }

  // Dynamic import: the fallback is real, but nobody downloads it to read the H1.
  const { DEMO: fixture } = await import('./demo-fixture.js');
  const cached = new Map(Object.entries(fixture.files).map(([path, file]) => [path, file.text]));
  return {
    report: analyseText(cached.get(DEMO.config), cached),
    origin: 'cached',
    notice:
      `Couldn't reach GitHub — showing a cached copy of ${DEMO.owner}/${DEMO.repo}@${DEMO.sha.slice(0, 7)}, ` +
      `taken ${DEMO.taken}. The finding below is real; the file may have changed since.`,
  };
}
