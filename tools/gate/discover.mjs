#!/usr/bin/env node
// Pre-launch gate, step 1: build the sample of real dependabot.yml files.
//
// Sampling frame (stated plainly, because a rate without a frame is a sales
// number):
//   * Pool A: repositories returned by GitHub code search for
//     `filename:dependabot.yml path:.github` (the 1,000 results the API exposes).
//   * Pool B: repositories with >= MIN_STARS stars, listed by the repository
//     search API in descending star order across star bands, that actually ship
//     `.github/dependabot.yml`.
//   A + B are deduplicated, star counts fetched via GraphQL, and anything below
//   MIN_INCLUDED_STARS is dropped. The result is "popular repos that have a
//   committed dependabot.yml" - not "all repos", and not a random sample of
//   Dependabot users.
//
// Usage: node tools/gate/discover.mjs [--limit 250] [--min-stars 3000] [--min-included-stars 1000]

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(here, 'cache');
const outFile = join(here, 'repos.json');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const limit = option('limit', 250);
const minStars = option('min-stars', 3000);
const minIncluded = option('min-included-stars', 1000);

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const HEADERS = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'user-agent': 'dependabot-doctor-gate',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(url, attempt = 0) {
  const response = await fetch(url, { headers: HEADERS });
  if (response.status === 403 || response.status === 429) {
    if (attempt > 6) throw new Error(`rate limited: ${url}`);
    const reset = Number(response.headers.get('x-ratelimit-reset') ?? 0) * 1000;
    const retryAfter = Number(response.headers.get('retry-after') ?? 0) * 1000;
    const wait = Math.max(retryAfter, reset - Date.now(), 5000);
    process.stderr.write(`rate limited, sleeping ${Math.round(wait / 1000)}s\n`);
    await sleep(Math.min(wait, 120000));
    return api(url, attempt + 1);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function graphql(query) {
  const output = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(output);
  if (parsed.errors) throw new Error(`graphql: ${parsed.errors[0]?.message}`);
  return parsed.data;
}

/** Pool A: code search for the config file itself. */
async function codeSearchPool() {
  const repos = new Map();
  for (let page = 1; page <= 10; page += 1) {
    const query = encodeURIComponent('filename:dependabot.yml path:.github');
    const data = await api(`https://api.github.com/search/code?q=${query}&per_page=100&page=${page}`);
    if (!data) break;
    for (const item of data.items ?? []) {
      const repo = item.repository;
      if (!repo || repo.archived || repo.disabled) continue;
      repos.set(repo.full_name, { full_name: repo.full_name, default_branch: repo.default_branch });
    }
    process.stderr.write(`code search page ${page}: ${repos.size} repos\n`);
    await sleep(6500);
    if ((data.items ?? []).length < 100) break;
  }
  return [...repos.values()];
}

/** Pool B: popular repos, checked for a config. */
async function popularPool() {
  const bands = [
    `stars:${minStars}..5000`,
    'stars:5000..8000',
    'stars:8000..12000',
    'stars:12000..20000',
    'stars:20000..35000',
    'stars:35000..60000',
    'stars:60000..100000',
    'stars:>=100000',
  ];
  const candidates = new Map();
  for (const band of bands) {
    for (let page = 1; page <= 4; page += 1) {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`${band} is:public archived:false`)}&sort=stars&order=desc&per_page=100&page=${page}`;
      const data = await api(url);
      if (!data) break;
      for (const item of data.items ?? []) {
        if (item.stargazers_count < minStars || item.fork) continue;
        candidates.set(item.full_name, {
          full_name: item.full_name,
          stars: item.stargazers_count,
          default_branch: item.default_branch,
          language: item.language,
        });
      }
      await sleep(2000);
      if ((data.items ?? []).length < 100) break;
    }
    process.stderr.write(`band ${band}: ${candidates.size} candidates\n`);
  }

  const withConfig = [];
  const items = [...candidates.values()];
  let index = 0;
  const workers = Array.from({ length: 12 }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      const repo = items[current];
      const config = await hasConfig(repo);
      if (config) withConfig.push({ ...repo, config_path: config.path, config_text: config.text, source: 'popular' });
    }
  });
  await Promise.all(workers);
  return withConfig;
}

async function hasConfig(repo) {
  for (const name of ['.github/dependabot.yml', '.github/dependabot.yaml']) {
    const url = `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${name}`;
    const response = await fetch(url, { headers: { 'user-agent': 'dependabot-doctor-gate' } });
    if (response.ok) {
      const text = await response.text();
      if (text.length < 300000) return { path: name, text };
    }
  }
  return null;
}

function starsFor(names) {
  const out = new Map();
  for (let i = 0; i < names.length; i += 80) {
    const batch = names.slice(i, i + 80);
    const fields = batch
      .map((full, index) => {
        const [owner, name] = full.split('/');
        return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner stargazerCount isArchived defaultBranchRef { name } }`;
      })
      .join('\n');
    const data = graphql(`query {\n${fields}\n}`);
    for (const key of Object.keys(data ?? {})) {
      const repo = data[key];
      if (!repo) continue;
      out.set(repo.nameWithOwner, {
        stars: repo.stargazerCount,
        archived: repo.isArchived,
        default_branch: repo.defaultBranchRef?.name ?? 'main',
      });
    }
    process.stderr.write(`stars: ${Math.min(i + 80, names.length)}/${names.length}\n`);
  }
  return out;
}

const poolA = await codeSearchPool();
const poolB = await popularPool();
process.stderr.write(`pool B: ${poolB.length} popular repos with a config\n`);

const merged = new Map();
for (const repo of poolB) merged.set(repo.full_name, repo);

const namesToScore = poolA.map((repo) => repo.full_name).filter((name) => !merged.has(name));
const stars = starsFor(namesToScore);
process.stderr.write(`fetched stars for ${stars.size} code-search repos\n`);

for (const repo of poolA) {
  const meta = stars.get(repo.full_name);
  if (!meta || meta.archived) continue;
  if (meta.stars < minIncluded) continue;
  const config = await hasConfig({ ...repo, default_branch: meta.default_branch });
  if (!config) continue;
  merged.set(repo.full_name, {
    full_name: repo.full_name,
    stars: meta.stars,
    default_branch: meta.default_branch,
    config_path: config.path,
    config_text: config.text,
    source: 'code-search',
  });
}

const repos = [...merged.values()]
  .filter((repo) => repo.stars >= minIncluded)
  .sort((a, b) => b.stars - a.stars)
  .slice(0, limit);

if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      frame: `code search (filename:dependabot.yml path:.github, first 1000) + repos with >=${minStars} stars; kept repos with >=${minIncluded} stars and a committed .github/dependabot.yml`,
      min_stars: minStars,
      min_included_stars: minIncluded,
      repos,
    },
    null,
    2,
  )}\n`,
);
process.stderr.write(`\n${repos.length} repositories written to ${outFile}\n`);
const spread = { '1k-5k': 0, '5k-20k': 0, '20k+': 0 };
for (const repo of repos) {
  if (repo.stars >= 20000) spread['20k+'] += 1;
  else if (repo.stars >= 5000) spread['5k-20k'] += 1;
  else spread['1k-5k'] += 1;
}
process.stderr.write(`star spread: ${JSON.stringify(spread)}\n`);
