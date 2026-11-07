# Dependabot groups not working? Why a group matches nothing (and how to check yours)

When Dependabot silently stops grouping, the only thing it tells you is one line
in an update-job log:

> Please check your configuration as there are groups where no dependencies match:

This finds that — and the case the log does not describe: a group that **did**
match, and lost its dependencies to a higher-scoring group. Offline, in one
command, without a token.

## What it looks like

Example: [`Fastjur/dependabot-group-specificity-repro`](https://github.com/Fastjur/dependabot-group-specificity-repro)
— the repro repo from [dependabot-core #14576](https://github.com/dependabot/dependabot-core/issues/14576),
deliberately tiny. Real output, pasted from a run pinned at `c0f39de`:

```
1 group matched, but lost its dependency to a higher-scoring group.
Checked 1 npm manifest. Read 3 files.

aws                       1 of 2 direct dependencies matched, then lost
                          to minor-and-patch-updates              dependabot.yml:9
  @aws-sdk/client-dynamodb matches @aws-sdk/* (scores 95) and was assigned to
  minor-and-patch-updates, which declares no patterns (scores 500).
  Applies to minor and patch updates.
```

Falsify it in two commands — no install, no account, nothing written:

```bash
git clone --depth 1 https://github.com/Fastjur/dependabot-group-specificity-repro /tmp/repro
npx --yes github:seipass/dependabot-doctor#v0.1.0 /tmp/repro
```

`minor-and-patch-updates` declares no `patterns` at all, which scores **500**;
`@aws-sdk/*` scores **95**; the highest score wins, so `aws` is left with
nothing even though it is written first. Swap the two groups in the file and the
output does not change.

## Run it

```bash
npx --yes github:seipass/dependabot-doctor#v0.1.0
```

Run from the repository you want to check; it reads
`.github/dependabot.yml` (or `.yaml`) and the manifests that file names. No
flags needed. `npx` installs from the git tag, so this works with no npm account
and no registry publication.

Other ways in:

```bash
# a single file, from a clone (Node 18+, zero runtime dependencies)
node bin/dependabot-doctor.js /path/to/repo

# a GitHub Actions step
- uses: seipass/dependabot-doctor@v0.1.0
  with:
    path: .
    fail-on: all

# pre-commit
- repo: https://github.com/seipass/dependabot-doctor
  rev: v0.1.0
  hooks:
    - id: dependabot-doctor
```

## What it checks

| code | what it means | needs a lockfile? |
|---|---|---|
| `no-op-group` | a group matches no dependency (`why`: zero match, empty `patterns` list, allow list excludes every match, or every match is fully ignored) | yes |
| `captured-by-score` | a group matches dependencies, but a higher-scoring group takes them all | yes |
| `ignore-no-match` | an `ignore` rule matches no dependency, so it blocks nothing | yes |
| `directory-no-match` | a `directory`/`directories` entry matches no directory in this checkout | no |
| `ecosystem-absent` | an ecosystem is configured where no manifest of that kind exists | no |
| `flood-risk` | daily schedule, no groups, capped open PRs, many direct dependencies | no |

"Needs a lockfile" is the honesty gate: without a committed lockfile we cannot
see the dependency set Dependabot resolves, so those checks are **skipped with a
reason** instead of guessed. A `skip` never becomes a finding.

## `If a dependency matches more than one rule, it's included in the first group that it matches`

That sentence is from GitHub's options reference, and since September 2025 the
updater does something else. In
[`pattern_specificity_calculator.rb`](https://github.com/dependabot/dependabot-core/blob/main/updater/lib/dependabot/updater/pattern_specificity_calculator.rb)
(merged in [#13044](https://github.com/dependabot/dependabot-core/pull/13044),
made unconditional by
[#14861](https://github.com/dependabot/dependabot-core/pull/14861)) every group
that contains a dependency **keeps** it, unless another matching group scores
strictly higher:

| case | score |
|---|---|
| pattern equal to the dependency name | 1000 |
| group with no `patterns` key at all | 500 |
| wildcard pattern | `100 - 10 x wildcards + max(len-5, 0)`, floor 1 |
| universal `*` | 1 |
| `patterns: []` (key present, empty list) | 0 — matches nothing |
| `exclude-patterns` hit, or no pattern matches | 0 |

Consequences we depend on:

- **File order never decides membership.** A catch-all written *first* does not
  steal from a specific group written later, and we never report that it did.
- **A tie is not a defect.** If two groups score equally, both keep the
  dependency, so neither is empty and we print nothing. A dependency belongs to
  every group that contains it.
- **No `patterns` key and `patterns: []` are opposites.** Absent = 500, a
  catch-all that takes dependencies from pattern groups. Empty list = 0, matches
  nothing. The finding says which one it is.
- **`update-types` on the winning group scopes the effect.** The finding states
  `Applies to minor and patch updates` (or `Applies to any update type`) because
  the comparison depends on an update type that cannot be known offline.

Our model of this is in `core/specificity.js`, ported constant-for-constant, and
`test/precedence.test.js` fails if membership ever becomes order-dependent.

## `dependabot groups not working`

Two different bugs hide behind that search, and they need opposite fixes:

1. **Matches nothing.** A typo in `patterns`, a dependency that was removed, a
   group narrowed by `exclude-patterns`, or an `allow` list that excludes every
   match. Fix: widen the pattern, or delete the group.
2. **Matched, then captured.** The group is fine but something else scores
   higher — usually a group with no `patterns` key (500) or a group whose
   patterns are more specific. Fix: make this group's patterns more specific,
   or give the catch-all `patterns: ["*"]` so it scores 1 instead of 500.

## `dependabot.yml ignore not working`

`ignore` is applied at the version level, and the conditions are unioned:
every matching rule contributes, and a rule with neither `versions` nor
`update-types` removes **all** versions. So an ignore rule fails in three ways,
and only the first is visible to this tool:

- the `dependency-name` pattern matches no dependency in the resolved set →
  `ignore-no-match`, with the count of dependencies it was tested against;
- the pattern matches, but a group is narrowed by `allow`/`dependency-type`
  before grouping runs (Dependabot filters `allowed_dependencies` first), so the
  rule is moot → reported as `no-op-group` with `why: allow-excluded`;
- the pattern matches but the version range never applies → **not detectable
  offline**: we do not know which updates are pending, and we do not guess.

## What this cannot see

- **An update being available, or its type** (major/minor/patch). We only read
  what is committed. Any statement about "would an update fire" is out of scope.
- **Ecosystems without an enumerator.** v1 enumerates `npm`, `pip`, `uv`,
  `gomod`, `cargo`, `docker`, `github-actions`. Everything else is reported as
  skipped, never as absent or empty.
- **No lockfile, no claim.** Without a committed lockfile (npm: package-lock,
  yarn.lock or pnpm-lock.yaml; pip/uv: poetry.lock, uv.lock, pdm.lock or
  Pipfile.lock; gomod: go.sum; cargo: Cargo.lock) the transitive set is unknown,
  so group and ignore checks are skipped.
- **Version ranges.** `versions:` in an `ignore` rule is never evaluated.
- **Security updates.** Groups with `applies-to: security-updates` depend on the
  advisory database; we skip them. `ignore.update-types` is inert for security
  updates, which we do not model.
- **`multi-ecosystem-groups`.** Not modelled (the key is accepted, the grouping
  is not simulated).
- **Per-directory granularity.** Dependabot evaluates emptiness per
  `(directory, ecosystem)`; when an entry declares several directories we merge
  them. That can hide a group that is empty in one directory only — we err
  towards silence, not towards a finding.
- **`directories:` glob semantics** are documented as `*` only. We also accept
  `**`, which can only make us quieter.
- **Config validity.** We check matching, not validity. We do not claim a file is
  valid, and we do not claim GitHub would reject one.
- **Writing files.** There is no write path in this package: findings, fix
  suggestions and any diff are printed, never applied.

## Exit codes

| code | meaning |
|---|---|
| 0 | no findings that match `--fail-on` (default: every error/warning; `flood-risk` is advisory and does not fail) |
| 2 | findings |
| 1 | usage error, unreadable config, or a config we cannot interpret |

## `--json`

```jsonc
{
  "version": "0.1.0",
  "root": "C:/repos/x",
  "file": ".github/dependabot.yml",
  "ok": true,
  "entries": [{ "ecosystem": "npm", "directory": "/", "groups": ["aws"], "schedule": "weekly" }],
  "defects": [{
    "code": "captured-by-score",
    "kind": "captured-by-score",          // alias of code
    "severity": "warning",
    "ecosystem": "npm",
    "directory": "/",
    "target": "aws",
    "group": "aws",
    "winner": "minor-and-patch-updates",
    "scores": { "this": 95, "winner": 500 },
    "update_types": null,
    "winner_update_types": ["minor", "patch"],
    "effective_update_types": ["minor", "patch"],
    "matched": 0,                          // dependencies that reach this group
    "reaching": 0,                         // alias of matched
    "matched_by_rule": 26,                 // dependencies the rules matched
    "direct_matched_by_rule": 1,
    "total": 90,                           // dependencies enumerated (lockfile included)
    "direct_total": 2,                     // declared in the manifest
    "why": "captured",
    "yml_line": 9,
    "detail": "...",
    "evidence": { "patterns": ["@aws-sdk/*"], "...": "..." },
    "suggestion": "..."
  }],
  "findings": [/* same array, older key */],
  "skipped": [{ "check": "dependency-set", "reason": "npm at /: no lockfile committed ..." }],
  "warnings": [],
  "errors": [],
  "summary": {
    "entries": 1, "groups_total": 2, "groups_empty": 0,
    "ignores_total": 0, "ignores_unmatched": 0,
    "directories_unmatched": 0, "ecosystems_absent": 0, "flood_risks": 0
  },
  "manifests": { "npm": 1 },
  "files": { "read": 3, "scanned": 3, "directories": 2 },
  "exit": 2
}
```

`code` is the durable identifier; `kind` mirrors it for consumers written against
an older draft. Counts are always labelled: `matched_by_rule` (rules matched,
lockfile included) is not `matched` (dependencies that reached the group), and
`direct_total` is what the manifest declares. Every finding cites `yml_line`.

## How the model was verified

- Matching semantics read from `dependabot-core` at commit
  `d7b08f3309a484ea73d202ba30740530d40642e7` (2026-11-06):
  `updater/lib/dependabot/dependency_group_engine.rb`,
  `updater/lib/dependabot/updater/pattern_specificity_calculator.rb`,
  `updater/lib/dependabot/updater/group_dependency_selector.rb`,
  `updater/lib/dependabot/dependency_snapshot.rb` (allow filtering precedes
  grouping), `common/lib/dependabot/config/update_config.rb` and
  `ignore_condition.rb` (union, not first match), and
  `common/lib/dependabot/config/file.rb` (ecosystem enum, name normalisers).
- 80 tests, including a `git apply --check` test on the printed patch and the counter-cases: order-independence, equal-score ties,
  `patterns: []` versus absent, allow-before-grouping, PEP 503 name matching,
  a 500/500 tie, and a repo with no lockfile (which must produce no finding).
- Real configs: 23 of 23 public `.github/dependabot.yml` files used during
  development parse, including `cli/cli` (block sequence at parent indentation),
  `microsoft/vscode` (`devcontainers`), `weppos/whois` (leading `---`),
  `docsifyjs/docsify` (flow sequence on the next line) and `python/cpython`
  (trailing slashes). Parsing them is not the same as covering every config ever
  written, and we make no such claim.

If Dependabot changes this scoring, this tool is wrong and this file is stale.
The commit above is the version it was built against.

## Development

```bash
npm test                    # node --test, no dependencies
node bin/dependabot-doctor.js .          # this repo lints clean
node tools/gate/run.mjs     # pre-launch sweep over real repositories
```

## CI

`.github/workflows/ci.yml` runs the suite on `ubuntu-latest` and
`windows-latest`, on Node 20 and 24, lints this repository's own
`dependabot.yml`, and checks the JSON contract.

MIT licensed.
