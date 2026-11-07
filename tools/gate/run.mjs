#!/usr/bin/env node
// Pre-launch gate, step 2: materialize each repository's relevant files and run
// the real CLI against them. Everything here is fetched from
// raw.githubusercontent.com at a pinned commit; nothing is executed from the
// sampled repositories, only read.
//
// Usage: node tools/gate/run.mjs [--limit 200] [--concurrency 6] [--refresh]

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const cacheDir = join(here, 'cache');
const reposFile = join(here, 'repos.json');
const resultsFile = join(here, 'results.json');
const bin = join(projectRoot, 'bin', 'dependabot-doctor.js');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const limit = option('limit', 200);
const concurrency = option('concurrency', 6);
const refresh = args.includes('--refresh');

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const HEADERS = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'user-agent': 'dependabot-doctor-gate',
};

const RELEVANT = [
  /^\.github\/dependabot\.ya?ml$/,
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^action\.ya?ml$/,
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)pdm\.lock$/,
  /(^|\/)Pipfile$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)setup\.py$/,
  /(^|\/)setup\.cfg$/,
  /(^|\/)requirements[^/]*\.(txt|in)$/,
  /(^|\/)go\.mod$/,
  /(^|\/)go\.sum$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)(dockerfile|containerfile)([.-][^/]*)?$/i,
  /(^|\/)[^/]*\.(dockerfile|containerfile)$/i,
  /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i,
  /(^|\/)Gemfile$/,
  /(^|\/)composer\.json$/,
  /(^|\/)pom\.xml$/,
  /(^|\/)build\.gradle(\.kts)?$/,
];

const MAX_FILES = 120;
const MAX_FILE_BYTES = 4_000_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(url) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers: HEADERS });
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset') ?? 0) * 1000;
      const wait = Math.max(2000, reset - Date.now());
      process.stderr.write(`rate limited, sleeping ${Math.round(wait / 1000)}s\n`);
      await sleep(Math.min(wait, 120000));
      continue;
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.json();
  }
  throw new Error(`giving up on ${url}`);
}

async function raw(repo, sha, path) {
  const url = `https://raw.githubusercontent.com/${repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { headers: { 'user-agent': 'dependabot-doctor-gate' } });
    if (response.status === 404) return null;
    if (!response.ok) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_FILE_BYTES) return null;
    return response.text();
  }
  return null;
}

async function pool(items, size, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

const catalogue = JSON.parse(readFileSync(reposFile, 'utf8'));
const repos = catalogue.repos.slice(0, limit);
process.stderr.write(`materializing ${repos.length} repositories...\n`);

const results = await pool(repos, concurrency, async (repo) => {
  const dirKey = repo.full_name.replace('/', '__');
  const dir = join(cacheDir, dirKey);
  const manifestFile = join(dir, '.gate-manifest.json');
  if (existsSync(manifestFile) && !refresh) {
    const saved = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (Array.isArray(saved.paths)) return runOne(repo, dir, saved);
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const commit = await api(`https://api.github.com/repos/${repo.full_name}/commits/${repo.default_branch}`);
  if (!commit) return { repo: repo.full_name, error: 'no commit' };
  const sha = commit.sha;
  const tree = await api(`https://api.github.com/repos/${repo.full_name}/git/trees/${sha}?recursive=1`);
  if (!tree) return { repo: repo.full_name, error: 'no tree' };

  const paths = (tree.tree ?? []).filter((entry) => entry.type === 'blob').map((entry) => entry.path);
  const wanted = paths.filter((path) => RELEVANT.some((pattern) => pattern.test(path))).slice(0, MAX_FILES);

  const files = [];
  for (const path of wanted) {
    const text = await raw(repo.full_name, sha, path);
    if (text == null) continue;
    const absolute = join(dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
    files.push(path);
  }
  const saved = { sha, truncated: Boolean(tree.truncated), tree_size: paths.length, paths, files };
  writeFileSync(manifestFile, JSON.stringify(saved));
  return runOne(repo, dir, saved);
});

function runOne(repo, dir, meta) {
  const configPath = ['.github/dependabot.yml', '.github/dependabot.yaml'].find((name) => existsSync(join(dir, name)));
  if (!configPath) return { repo: repo.full_name, stars: repo.stars, error: 'config missing after fetch' };
  const configText = readFileSync(join(dir, configPath), 'utf8');
  // The checkout holds only the files we chose to fetch; hand the CLI the real
  // tree so directory/ecosystem checks see the repository as it is.
  const treeFile = `${dir}.tree.json`;
  writeFileSync(treeFile, JSON.stringify({ paths: meta.paths ?? [] }));
  const started = Date.now();
  const result = spawnSync(process.execPath, [bin, dir, '--json', '--no-color', '--tree', treeFile], {
    encoding: 'utf8',
    timeout: 60000,
  });
  const durationMs = Date.now() - started;
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return {
      repo: repo.full_name,
      stars: repo.stars,
      error: 'non-JSON output',
      stderr: result.stderr.slice(0, 400),
      status: result.status,
    };
  }
  return {
    repo: repo.full_name,
    stars: repo.stars,
    sha: meta.sha,
    truncated_tree: meta.truncated,
    files_materialized: meta.files.length,
    market: detectMarket(configText),
    status: result.status,
    duration_ms: durationMs,
    ok: payload.ok,
    errors: payload.errors,
    entries: payload.entries,
    defects: payload.defects,
    skipped: payload.skipped,
    summary: payload.summary,
  };
}

/** Which package managers the config contains, for the stratum table. */
function detectMarket(configText) {
  const found = new Set();
  for (const match of configText.matchAll(/package-ecosystem:\s*["']?([\w-]+)/g)) found.add(match[1]);
  return [...found].sort();
}

const usable = results.filter((item) => item && !item.error && item.ok);
const unusable = results.filter((item) => item && (item.error || !item.ok));
const skippedTrees = usable.filter((item) => item.truncated_tree).map((item) => item.repo);
const scorable = usable.filter((item) => !item.truncated_tree);

const CERTAIN = ['no-op-group', 'captured-by-score', 'ignore-no-match', 'directory-no-match', 'ecosystem-absent'];
const count = (items, code) => items.reduce((sum, item) => sum + item.defects.filter((defect) => defect.code === code).length, 0);

const withFinding = scorable.filter((item) => item.defects.some((defect) => CERTAIN.includes(defect.code)));
const withFlood = scorable.filter((item) => item.defects.some((defect) => defect.code === 'flood-risk'));
const withCapture = scorable.filter((item) => item.defects.some((defect) => defect.code === 'captured-by-score'));
const withNoopGroup = scorable.filter((item) => item.defects.some((defect) => defect.code === 'no-op-group'));
const withIgnore = scorable.filter((item) => item.defects.some((defect) => defect.code === 'ignore-no-match'));
const fullySkipped = scorable.filter((item) => item.defects.length === 0 && item.skipped.length > 0 && item.skipped.every((entry) => entry.check === 'dependency-set'));

const pct = (part, whole) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

// Stratum: does the config even contain groups with patterns / ignores /
// directories? A config with no groups has nothing for us to find, and saying
// so is more honest than a single headline rate.
const withGroups = scorable.filter((item) => (item.summary?.groups_total ?? 0) > 0);
const withPatternGroups = scorable.filter((item) => item.entries.some((entry) => entry.groups_with_patterns > 0));
const withPatternlessGroups = scorable.filter((item) => item.entries.some((entry) => entry.groups_without_patterns > 0));
const tieShaped = scorable.filter((item) => item.entries.some((entry) => entry.groups_without_patterns > 1));

const summary = {
  generated_at: new Date().toISOString(),
  sample: {
    requested: repos.length,
    materialized: results.length,
    scorable: scorable.length,
    excluded_unparseable: unusable.length,
    excluded_truncated_tree: skippedTrees.length,
  },
  gate: {
    repos_with_a_certain_finding: withFinding.length,
    rate_percent: pct(withFinding.length, scorable.length),
    repos_with_capture: withCapture.length,
    rate_capture_percent: pct(withCapture.length, scorable.length),
    repos_with_ignore_finding: withIgnore.length,
    rate_ignore_percent: pct(withIgnore.length, scorable.length),
    repos_with_flood_risk: withFlood.length,
    rate_flood_percent: pct(withFlood.length, scorable.length),
    repos_all_skipped: fullySkipped.length,
  },
  strata: {
    configs_with_groups: withGroups.length,
    configs_with_pattern_groups: withPatternGroups.length,
    configs_with_patternless_groups: withPatternlessGroups.length,
    configs_with_a_capture: withCapture.length,
    configs_tie_shaped_two_or_more_patternless_groups: tieShaped.length,
    rate_among_configs_with_groups_percent: pct(withFinding.filter((item) => withGroups.includes(item)).length, withGroups.length),
    rate_capture_among_configs_with_pattern_groups_percent: pct(
      withCapture.filter((item) => withPatternGroups.includes(item)).length,
      withPatternGroups.length,
    ),
  },
  by_code: Object.fromEntries(CERTAIN.concat('flood-risk').map((code) => [code, count(scorable, code)])),
  defects_by_star_band: starBands(scorable),
  unparseable: unusable.map((item) => ({ repo: item.repo, stars: item.stars, error: item.error ?? 'config error', errors: item.errors?.slice(0, 3) })),
  truncated_trees: skippedTrees,
  findings: scorable
    .flatMap((item) => item.defects.map((defect) => ({ repo: item.repo, stars: item.stars, ...pick(defect) })))
    .sort((a, b) => a.code.localeCompare(b.code) || b.stars - a.stars),
  repos: scorable.map((item) => ({
    repo: item.repo,
    stars: item.stars,
    sha: item.sha,
    market: item.market,
    findings: item.defects.map((defect) => defect.code),
    skipped: item.skipped.length,
    duration_ms: item.duration_ms,
  })),
};

function pick(defect) {
  return {
    code: defect.code,
    severity: defect.severity,
    ecosystem: defect.ecosystem,
    directory: defect.directory,
    target: defect.target,
    group: defect.group,
    matched: defect.matched,
    total: defect.total,
    yml_line: defect.yml_line,
    detail: defect.detail,
    why: defect.why,
    scores: defect.scores,
  };
}

function starBands(items) {
  const bands = [
    [3000, 10000],
    [10000, 50000],
    [50000, Infinity],
  ];
  return bands.map(([low, high]) => {
    const inside = items.filter((item) => item.stars >= low && item.stars < high);
    return {
      band: `${low}-${high === Infinity ? '+' : high}`,
      repos: inside.length,
      with_finding: inside.filter((item) => item.defects.some((defect) => CERTAIN.includes(defect.code))).length,
      rate_percent: pct(inside.filter((item) => item.defects.some((defect) => CERTAIN.includes(defect.code))).length, inside.length),
    };
  });
}

writeFileSync(resultsFile, `${JSON.stringify(summary, null, 2)}\n`);

console.log(`repos with a certain finding: ${summary.gate.repos_with_a_certain_finding}/${scorable.length} = ${summary.gate.rate_percent}%`);
console.log(`  captured-by-score: ${summary.gate.repos_with_capture} (${summary.gate.rate_capture_percent}%)`);
console.log(`  ignore-no-match:   ${summary.gate.repos_with_ignore_finding} (${summary.gate.rate_ignore_percent}%)`);
console.log(`  flood-risk (info): ${summary.gate.repos_with_flood_risk} (${summary.gate.rate_flood_percent}%)`);
console.log(`  all checks skipped: ${summary.gate.repos_all_skipped}`);
console.log(`strata: ${summary.strata.configs_with_groups} configs have groups -> rate among them ${summary.strata.rate_among_configs_with_groups_percent}%`);
console.log(`by code: ${JSON.stringify(summary.by_code)}`);
console.log(`excluded: ${unusable.length} unparseable, ${skippedTrees.length} truncated tree`);
if (unusable.length > 0) console.log('unparseable sample:', unusable.slice(0, 8).map((item) => `${item.repo}: ${item.error}`).join('\n  '));
console.log(`\nfull results: ${resultsFile}`);
