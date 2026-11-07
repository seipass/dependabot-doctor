// Orchestration: text of dependabot.yml + a repo view -> defects.
//
// Pure and synchronous. The CLI supplies a node:fs view, the browser page
// supplies a view backed by the GitHub trees API, tests supply an in-memory
// map. Nothing here touches the filesystem or the network.

import { parseConfig, ConfigError, ECOSYSTEMS } from './config.js';
import { createContext } from './deps/index.js';
import { isManifestFile } from './manifests.js';
import { runChecks } from './checks.js';

export const VERSION = '0.1.3';

/**
 * @param {{
 *   configText: string,
 *   file?: string,
 *   view: {root?: string, directories?: string[], filePaths: string[], read: (path:string)=>string|null}
 * }} input
 */
export function analyze({ configText, file = '.github/dependabot.yml', view }) {
  let config;
  try {
    config = parseConfig(configText, file);
  } catch (error) {
    if (error instanceof ConfigError) {
      return failure(file, error.errors, []);
    }
    throw error;
  }

  const ctx = createContext(view);
  const { defects, skipped } = runChecks({ config, ctx });

  // "Read N files" is derived from what the collectors actually opened, never a
  // literal: the +1 is dependabot.yml itself.
  const readPaths = [...ctx.readLog];
  const manifests = {};
  for (const entry of config.entries) {
    const count = readPaths.filter((path) => isManifestFile(entry.ecosystem, path)).length;
    if (count === 0) continue;
    manifests[entry.ecosystem] = Math.max(manifests[entry.ecosystem] ?? 0, count);
  }

  return {
    ok: true,
    version: VERSION,
    file,
    root: view.root ?? '.',
    entries: config.entries.map((entry) => ({
      ecosystem: entry.ecosystem,
      directory: entry.directoryMode === 'single' ? entry.directories[0] : entry.directories,
      directory_mode: entry.directoryMode,
      schedule: entry.schedule?.interval ?? null,
      open_pull_requests_limit: entry.openPullRequestsLimit,
      groups: entry.groups.map((group) => group.name),
      groups_without_patterns: entry.groups.filter((group) => group.patterns == null).length,
      groups_with_patterns: entry.groups.filter((group) => group.patterns != null).length,
      ignore_rules: entry.ignore.length,
      allow_rules: entry.allow.length,
      line: entry.line,
    })),
    defects,
    skipped,
    warnings: config.warnings,
    errors: [],
    summary: summarize(config, defects, ctx),
    manifests,
    files: {
      read: readPaths.length + 1,
      scanned: ctx.filePaths.length,
      directories: ctx.directories.length,
      read_paths: readPaths,
    },
    ecosystems_known: ECOSYSTEMS.length,
    config: undefined,
    ctx: undefined,
  };
}

function failure(file, errors, warnings) {
  return {
    ok: false,
    version: VERSION,
    file,
    root: '.',
    entries: [],
    defects: [],
    skipped: [],
    warnings,
    errors,
    summary: {
      entries: 0,
      groups_total: 0,
      groups_empty: 0,
      ignores_total: 0,
      ignores_unmatched: 0,
      directories_unmatched: 0,
      ecosystems_absent: 0,
      flood_risks: 0,
    },
    manifests: {},
    files: { read: 1, scanned: 0, directories: 0 },
  };
}

function summarize(config, defects, ctx) {
  const empty = defects.filter((defect) => defect.code === 'no-op-group');
  return {
    entries: config.entries.length,
    groups_total: config.entries.reduce((sum, entry) => sum + entry.groups.length, 0),
    groups_empty: empty.length,
    ignores_total: config.entries.reduce((sum, entry) => sum + entry.ignore.length, 0),
    ignores_unmatched: defects.filter((defect) => defect.code === 'ignore-no-match').length,
    directories_unmatched: defects.filter((defect) => defect.code === 'directory-no-match').length,
    ecosystems_absent: defects.filter((defect) => defect.code === 'ecosystem-absent').length,
    flood_risks: defects.filter((defect) => defect.code === 'flood-risk').length,
    directories_scanned: ctx.directories.length,
  };
}
