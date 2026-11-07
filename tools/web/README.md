# The browser layer: how the page is built, and what to do when the CLI moves

Two audiences: whoever next touches `docs/`, and whoever builds page #2 for
`workflow-trigger-check`. Everything here is measured; where it is not, it says so.

## What is where

| Path | Job |
|---|---|
| `docs/index.html` | screen 1 and every state, copy verbatim from `launch/page-copy.md` |
| `docs/js/app.js` | DOM only. Reads `VERSION` from the vendored engine, so the footer cannot drift |
| `docs/js/check.js` | paste / repo orchestration → `analyze()` → blocks |
| `docs/js/github.js` | transport: `raw.githubusercontent.com`, plus one optional `api.github.com` call |
| `docs/js/probe-plan.js` | which files to ask for, per ecosystem |
| `docs/js/view.js` | the repo view + the one place the page is narrower than the CLI |
| `docs/js/report.js` | splits `renderText()` output into verdict / count / findings / §5 skips / clean state |
| `docs/js/demo.js`, `demo-fixture.js` | pinned demo: live first, inlined fallback |
| `docs/js/vendor/core/**` | byte mirror of a release tag |
| `tools/web/sync-vendor.mjs` | the only writer of the mirror |
| `test/web-mirror.test.js` | the drift guard (runs under `npm test`) |

## The one rule

The page does not match `dependabot.yml` itself. It imports `analyze()` and
`renderText()` from `docs/js/vendor/core/`, which is **byte-identical to a release
tag**. `core/` imports nothing from Node, which is why the same bytes are valid in
both places. If you are tempted to re-derive anything — a score, a sort order, a
verdict sentence — the answer is to change `core/` and cut a tag, not to write a
second implementation in the page.

## Re-vendoring (do this after every release)

```
node tools/web/sync-vendor.mjs --ref v0.1.x --fixture ../../fixtures/demo-repro-c0f39de
node --test test/web-mirror.test.js     # or: npm test
scripts/preflight-page.sh dependabot-doctor --pinned c0f39dec5e2763707c6ff5abdb7f18d88383ea0f
scripts/check-demo-frozen.sh
```

Then update the install line and the footer in `docs/index.html` if the release
changed them (`sync-vendor` writes `RELEASE.json`; it does not edit HTML).

`test/web-mirror.test.js` fails on: mirror ≠ `RELEASE.json`, mirror ≠ the tag blobs,
a module reachable from `app.js` missing from the mirror, a demo finding that moved
one character, a probe-table entry that no longer covers a name `core/deps/*.js`
opens, or any storage API in the published scripts.

## Deliberate differences from the CLI (not drift)

1. **`Read N files.` is stripped** from the verdict line (Outreach's ruling; recorded
   in `scripts/check-demo-frozen.sh`).
2. **`directory-no-match` and `ecosystem-absent` are suppressed in probe mode** and
   replaced by the sanctioned §5 skip. A browser cannot list a directory, and
   `core/checks.js`'s own rule is that anything unprovable is skipped, never a
   defect. If someone "fixes" this to match the CLI, they reintroduce the
   false-positive class. When a `git/trees` listing *is* available the page passes
   `listing: 'full'` and every check runs.
3. **Entries whose ecosystem is discovered by walking a directory** (`github-actions`,
   `docker`, `pip`, `uv`) are uncheckable in probe mode even when the collector
   claims completeness: a walk that finds nothing returns "complete, zero
   dependencies", which the engine turns into "matched 0 of 0". Measured on
   `seipass/dependabot-doctor`, which reported its `actions/*` group as matching
   nothing while its workflows existed and were simply never listed.
4. **Groups that were never evaluated are counted** in the verdict
   (`We couldn't check N groups.`) and the clean verdict sentence is dropped, because
   "All N of your groups match" is a claim about every group and a clean-looking
   result is the most damaging thing this page can print.
5. **The clean state renders `page-copy.md` §4 instead of the engine's clean line** —
   §4 carries the same counts, and three statements of one fact reads like padding.

## Transport facts (measured, with the date they were measured)

- `raw.githubusercontent.com`: `Access-Control-Allow-Origin: *`; `HEAD` resolves;
  404 for absent and for private alike. A `Range: bytes=0-1048575` request returns
  **206 even for a 417-byte file**, and `Content-Range` is not CORS-exposed — so the
  size cap is decided from `Content-Length` (CORS-safelisted): a slice shorter than
  the cap is the whole file, a slice equal to it is reported as too large rather than
  half-read.
- `api.github.com`: `git/trees/HEAD?recursive=1` 200, `X-RateLimit-*` readable via
  `Access-Control-Expose-Headers`. `branches?per_page=100` also 200 and readable, but
  **paginates** (191-branch repos need two calls).
- Cache: a module-scoped `Map`, TTL 5 minutes (mirrors raw's `max-age=300`). No
  `localStorage`, `sessionStorage`, IndexedDB or cookie — the page says "Nothing is
  stored" and a test enforces it.

## Next release that needs a page change

`v0.1.3` (`57914d8`) changes `verdictLines()` and `sortDefects()`: entry-based
verdict, captures-only sentence, clean sentence only when every dependency set was
enumerated, `flood-risk` excluded from the count and on its own line, findings
ordered by measured frequency then line. The public signature is unchanged, so the
page needs **only a re-vendor** — plus:

1. `launch/page-copy.md` §3d must be rewritten first, or `check-demo-frozen.sh` and
   `test/web-mirror.test.js` both go red against the new renderer (that red is the
   gate working, not a failure).
2. The H1/SUB swap (`Which parts of your dependabot.yml don't apply to this repo`)
   must go in the same commit as the re-vendor: an H1 about entries over a verdict
   about groups is the first inconsistency a careful reader catches.
3. While on `v0.1.3`, check the verdict arithmetic against Strategy's split:
   five codes count toward "don't apply", `flood-risk` does not.

## For page #2 (`workflow-trigger-check`)

`github.js`, `view.js` and `report.js` are product-agnostic; reuse them. What is new:

- `analyze({workflows, view, branches})`, with `branches: null` meaning "make no
  branch claim" and the skip printed.
- Announce **per call**: tree and branch list are separate requests on one 60/hour
  budget. Use the analyzer's `needs.branches` to decide before announcing.
- Cap branch pagination (3 pages / 300 branches); a cap hit is `branches: null` →
  skip with "couldn't read the complete branch list", never a partial list.
