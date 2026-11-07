// dependabot.yml parsing + shape validation.
//
// Validation is deliberately split in two:
//   errors   -> the file cannot mean what its author intended (missing
//               required keys, wrong types, values outside the documented
//               enum, paths GitHub will reject). Exit code 1.
//   warnings -> valid-but-suspicious (unknown key, duplicate key). The
//               dependabot.yml schema grows over time, so an unknown key is
//               reported but never treated as fatal. Under-claiming beats
//               telling someone their working config is broken.

import { parseYaml, YamlError, mapEntry } from './yaml.js';

/**
 * `package-ecosystem` values accepted in dependabot.yml.
 * Source: the keys of PACKAGE_MANAGER_LOOKUP in
 * common/lib/dependabot/config/file.rb (dependabot-core, commit d7b08f3).
 */
export const ECOSYSTEMS = [
  'apm',
  'bazel',
  'bun',
  'bundler',
  'cargo',
  'composer',
  'conda',
  'deno',
  'devcontainer',
  'devcontainers',
  'docker',
  'docker-compose',
  'dotnet-sdk',
  'elm',
  'gitsubmodule',
  'github-actions',
  'gomod',
  'gradle',
  'helm',
  'julia',
  'maven',
  'mix',
  'nix',
  'npm',
  'nuget',
  'opentofu',
  'pip',
  'pre-commit',
  'pub',
  'rust-toolchain',
  'sbt',
  'swift',
  'terraform',
  'uv',
  'vcpkg',
];

export const INTERVALS = ['daily', 'weekly', 'monthly', 'quarterly', 'semiannually', 'yearly', 'cron'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const UPDATE_TYPE_VALUES = [
  'version-update:semver-major',
  'version-update:semver-minor',
  'version-update:semver-patch',
];
// Both vocabularies appear in the wild ("minor" in some repos, the documented
// "version-update:semver-minor" in others). We accept both and never rewrite
// them: normalising silently would misreport what is in the file.
const UPDATE_TYPE_ALIASES = ['major', 'minor', 'patch'];
const isUpdateType = (value) => UPDATE_TYPE_VALUES.includes(value) || UPDATE_TYPE_ALIASES.includes(value);
/**
 * Canonical form used for comparisons. dependabot.yml in the wild contains both
 * `minor` and `version-update:semver-minor` (both documented/executed); the raw
 * spelling is kept in `rawUpdateTypes` so output never rewrites the file.
 */
export function canonicalUpdateType(value) {
  if (typeof value !== 'string') return value;
  if (UPDATE_TYPE_ALIASES.includes(value)) return `version-update:semver-${value}`;
  return value;
}
const GROUP_RULE_KEYS = ['patterns', 'exclude-patterns', 'dependency-type', 'update-types', 'applies-to', 'group-by'];
const GROUP_KEYS = ['patterns', 'exclude-patterns', 'dependency-type', 'update-types', 'applies-to', 'group-by'];
const IGNORE_KEYS = ['dependency-name', 'versions', 'update-types'];
const ALLOW_KEYS = ['dependency-name', 'dependency-type', 'update-type', 'update-types'];
const TOP_KEYS = ['version', 'updates', 'registries', 'enable-beta-ecosystems', 'multi-ecosystem-groups'];
const ENTRY_KEYS = [
  'package-ecosystem',
  'directory',
  'directories',
  'schedule',
  'allow',
  'assignees',
  'commit-message',
  'cooldown',
  'enable-beta-ecosystems',
  'exclude-paths',
  'groups',
  'ignore',
  'insecure-external-code-execution',
  'labels',
  'milestone',
  'open-pull-requests-limit',
  'pull-request-branch-name',
  'rebase-strategy',
  'registries',
  'reviewers',
  'target-branch',
  'vendor',
  'versioning-strategy',
];
const SCHEDULE_KEYS = ['interval', 'day', 'time', 'timezone', 'cronjob'];

export class ConfigError extends Error {
  constructor(errors) {
    super(errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join('\n'));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

function isMap(node) {
  return Boolean(node && node.type === 'map');
}
function isSeq(node) {
  return Boolean(node && node.type === 'seq');
}
function scalarValue(node) {
  if (!node || node.type !== 'scalar') return undefined;
  return node.value;
}
function stringList(node) {
  if (!isSeq(node)) return undefined;
  const out = [];
  for (const item of node.items) {
    if (!item.value || item.value.type !== 'scalar' || typeof item.value.value !== 'string') return undefined;
    out.push(item.value.value);
  }
  return out;
}

/** Validate a `directory`/`directories` path the way GitHub does. */
function pathProblem(path, { allowGlob }) {
  if (typeof path !== 'string' || path.length === 0) return 'must be a non-empty string';
  if (!path.startsWith('/')) return 'must start with "/" (e.g. "/src"); dependabot resolves directories from the repository root';

  if (!allowGlob && path.includes('*')) return 'does not support globbing; use "directories" for globs';
  if (path.includes('..')) return 'must not contain ".."';
  if (path.includes('\\')) return 'must use "/" as the separator';
  return null;
}

function timezoneProblem(zone) {
  if (typeof zone !== 'string' || zone.trim() === '') return 'must be a non-empty string';
  try {
    // Node ships full ICU in modern builds; an unknown zone throws.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return null;
  } catch {
    return 'is not a known IANA time zone';
  }
}

/** Parse and validate a dependabot.yml document. */
export function parseConfig(source, file = '.github/dependabot.yml') {
  const errors = [];
  const warnings = [];
  const addError = (message, line, kind = 'shape') => errors.push({ message, line: line ?? null, kind });
  const addWarning = (message, line) => warnings.push({ message, line: line ?? null });

  let root;
  try {
    root = parseYaml(source);
  } catch (error) {
    if (error instanceof YamlError) {
      throw new ConfigError([
        {
          message: error.message.replace(/^line \d+: /, ''),
          line: error.line,
          kind: error.kind === 'unsupported' ? 'unsupported-yaml' : 'invalid-yaml',
        },
      ]);
    }
    throw error;
  }

  if (!isMap(root)) {
    throw new ConfigError([{ message: 'top level must be a mapping with "version" and "updates"', line: root.line }]);
  }

  const versionEntry = mapEntry(root, 'version');
  if (!versionEntry) addError('missing required top-level "version: 2"', root.line);
  else if (versionEntry.value.type !== 'scalar' || versionEntry.value.value !== 2) {
    addError('"version" must be the integer 2', versionEntry.keyLine);
  }

  for (const entry of root.entries) {
    if (!TOP_KEYS.includes(entry.key)) addWarning(`unknown top-level key "${entry.key}" (ignored by dependabot)`, entry.keyLine);
  }
  for (const dup of root.duplicateKeys || []) addError(`duplicate top-level key "${dup}"`, root.line);

  const updatesEntry = mapEntry(root, 'updates');
  if (!updatesEntry) {
    addError('missing required top-level "updates" list', root.line);
    throw new ConfigError(errors);
  }
  if (!isSeq(updatesEntry.value)) {
    addError('"updates" must be a list', updatesEntry.keyLine);
    throw new ConfigError(errors);
  }
  if (updatesEntry.value.items.length === 0) addError('"updates" is empty: no ecosystem is configured', updatesEntry.keyLine);

  const entries = [];
  updatesEntry.value.items.forEach((item, index) => {
    const parsed = parseUpdateEntry(item.value, index, item.line, { addError, addWarning });
    if (parsed) entries.push(parsed);
  });

  if (errors.length > 0) throw new ConfigError(errors);
  return { file, root, entries, warnings, errors };
}

function parseUpdateEntry(node, index, line, { addError, addWarning }) {
  const pointer = `updates[${index}]`;
  if (!isMap(node)) {
    addError(`${pointer} must be a mapping`, line);
    return null;
  }
  for (const entry of node.entries) {
    if (!ENTRY_KEYS.includes(entry.key)) {
      addWarning(`${pointer}: unknown key "${entry.key}" (ignored by dependabot)`, entry.keyLine);
    }
  }
  for (const dup of node.duplicateKeys || []) addError(`${pointer}: duplicate key "${dup}"`, line);

  const ecosystemEntry = mapEntry(node, 'package-ecosystem');
  if (!ecosystemEntry) {
    addError(`${pointer} is missing required key "package-ecosystem"`, line);
    return null;
  }
  const ecosystem = scalarValue(ecosystemEntry.value);
  if (typeof ecosystem !== 'string') {
    addError(`${pointer}.package-ecosystem must be a string`, ecosystemEntry.keyLine);
    return null;
  }
  if (!ECOSYSTEMS.includes(ecosystem)) {
    addError(
      `${pointer}.package-ecosystem "${ecosystem}" is not an ecosystem this tool knows; if Dependabot supports it, this tool is behind (known: ${ECOSYSTEMS.join(', ')})`,
      ecosystemEntry.keyLine,
    );
  }

  // directory / directories
  const dirEntry = mapEntry(node, 'directory');
  const dirsEntry = mapEntry(node, 'directories');
  let directoryMode = 'single';
  let directories = [];
  let directoryLines = [];
  let directoryLine = line;
  if (dirEntry && dirsEntry) {
    addError(`${pointer}: use either "directory" or "directories", not both`, dirsEntry.keyLine);
  } else if (dirsEntry) {
    directoryMode = 'multi';
    directoryLine = dirsEntry.keyLine;
    const list = stringList(dirsEntry.value);
    if (!list) addError(`${pointer}.directories must be a list of strings`, dirsEntry.keyLine);
    else if (list.length === 0) addError(`${pointer}.directories is empty`, dirsEntry.keyLine);
    else {
      for (const dir of list) {
        const problem = pathProblem(dir, { allowGlob: true });
        if (problem) addError(`${pointer}.directories entry "${dir}" ${problem}`, dirsEntry.keyLine);
      }
      directories = list.map(normalizeDirectory);
      directoryLines = dirsEntry.value.items.map((item, i) => ({ path: directories[i], line: item.line }));
    }
  } else if (dirEntry) {
    directoryLine = dirEntry.keyLine;
    const dir = scalarValue(dirEntry.value);
    const problem = pathProblem(dir, { allowGlob: false });
    if (problem) addError(`${pointer}.directory ${problem}`, dirEntry.keyLine);
    else {
      directories = [normalizeDirectory(dir)];
      directoryLines = [{ path: directories[0], line: dirEntry.keyLine }];
    }
  } else {
    addError(`${pointer} is missing required key "directory" (or "directories")`, line);
  }

  // schedule
  const scheduleEntry = mapEntry(node, 'schedule');
  let schedule = null;
  if (!scheduleEntry) {
    addError(`${pointer} is missing required key "schedule"`, line);
  } else if (!isMap(scheduleEntry.value)) {
    addError(`${pointer}.schedule must be a mapping with an "interval" key`, scheduleEntry.keyLine);
  } else {
    for (const entry of scheduleEntry.value.entries) {
      if (!SCHEDULE_KEYS.includes(entry.key)) {
        addWarning(`${pointer}.schedule: unknown key "${entry.key}" (ignored by dependabot)`, entry.keyLine);
      }
    }
    const intervalEntry = mapEntry(scheduleEntry.value, 'interval');
    if (!intervalEntry) {
      addError(`${pointer}.schedule is missing required key "interval"`, scheduleEntry.keyLine);
    } else {
      const interval = scalarValue(intervalEntry.value);
      if (typeof interval !== 'string' || !INTERVALS.includes(interval)) {
        addError(
          `${pointer}.schedule.interval must be one of ${INTERVALS.join(', ')}${interval ? ` (found "${interval}")` : ''}`,
          intervalEntry.keyLine,
        );
      }
    }
    const dayEntry = mapEntry(scheduleEntry.value, 'day');
    if (dayEntry) {
      const day = scalarValue(dayEntry.value);
      if (typeof day !== 'string' || !DAYS.includes(day.toLowerCase())) {
        addError(`${pointer}.schedule.day must be a weekday name (monday..sunday)`, dayEntry.keyLine);
      }
    }
    const tzEntry = mapEntry(scheduleEntry.value, 'timezone');
    if (tzEntry) {
      const problem = timezoneProblem(scalarValue(tzEntry.value));
      if (problem) addError(`${pointer}.schedule.timezone ${problem}`, tzEntry.keyLine);
    }
    const interval = scalarValue(mapEntry(scheduleEntry.value, 'interval')?.value) ?? null;
    const cronEntry = mapEntry(scheduleEntry.value, 'cronjob');
    if (interval === 'cron' && !cronEntry) {
      addError(`${pointer}.schedule.interval is "cron" but no "cronjob" is set`, scheduleEntry.keyLine);
    }
    if (interval !== 'cron' && cronEntry) {
      addWarning(`${pointer}.schedule.cronjob is only used when interval is "cron"`, cronEntry.keyLine);
    }
    schedule = {
      interval,
      day: scalarValue(dayEntry?.value) ?? null,
      cronjob: scalarValue(cronEntry?.value) ?? null,
      line: scheduleEntry.keyLine,
      endLine: scheduleEntry.value.endLine,
    };
  }

  // open-pull-requests-limit
  const limitEntry = mapEntry(node, 'open-pull-requests-limit');
  let openPullRequestsLimit = null;
  if (limitEntry) {
    const value = scalarValue(limitEntry.value);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      addError(`${pointer}.open-pull-requests-limit must be a non-negative integer`, limitEntry.keyLine);
    } else {
      openPullRequestsLimit = value;
    }
  }

  // groups
  const groupsEntry = mapEntry(node, 'groups');
  const groups = [];
  if (groupsEntry) {
    if (!isMap(groupsEntry.value)) {
      addError(`${pointer}.groups must be a mapping of group name to rules`, groupsEntry.keyLine);
    } else {
      for (const groupEntry of groupsEntry.value.entries) {
        const group = parseGroup(groupEntry, pointer, { addError, addWarning });
        if (group) groups.push(group);
      }
    }
  }

  // ignore
  const ignoreEntry = mapEntry(node, 'ignore');
  const ignore = [];
  if (ignoreEntry) {
    if (!isSeq(ignoreEntry.value)) {
      addError(`${pointer}.ignore must be a list`, ignoreEntry.keyLine);
    } else {
      ignoreEntry.value.items.forEach((item, i) => {
        const rule = parseIgnoreRule(item, pointer, i, { addError });
        if (rule) ignore.push(rule);
      });
    }
  }

  // allow
  const allowEntry = mapEntry(node, 'allow');
  const allow = [];
  if (allowEntry) {
    if (!isSeq(allowEntry.value)) {
      addError(`${pointer}.allow must be a list`, allowEntry.keyLine);
    } else {
      allowEntry.value.items.forEach((item, i) => {
        const rule = parseAllowRule(item, pointer, i, { addError, addWarning });
        if (rule) allow.push(rule);
      });
    }
  }

  const excludePathsEntry = mapEntry(node, 'exclude-paths');
  const excludePaths = excludePathsEntry ? stringList(excludePathsEntry.value) ?? [] : [];

  const labelsEntry = mapEntry(node, 'labels');
  if (labelsEntry && stringList(labelsEntry.value) === undefined) {
    addError(`${pointer}.labels must be a list of strings`, labelsEntry.keyLine);
  }

  const registriesEntry = mapEntry(node, 'registries');
  if (registriesEntry) {
    if (stringList(registriesEntry.value) === undefined) {
      addError(`${pointer}.registries must be a list of registry names`, registriesEntry.keyLine);
    } else if (root_registriesMissing(node)) {
      addWarning(`${pointer} references registries but the top-level "registries" key is missing`, registriesEntry.keyLine);
    }
  }

  const rebaseEntry = mapEntry(node, 'rebase-strategy');
  if (rebaseEntry) {
    const value = scalarValue(rebaseEntry.value);
    if (!['auto', 'disabled'].includes(value)) {
      addError(`${pointer}.rebase-strategy must be "auto" or "disabled"`, rebaseEntry.keyLine);
    }
  }

  const targetBranchEntry = mapEntry(node, 'target-branch');
  if (targetBranchEntry && typeof scalarValue(targetBranchEntry.value) !== 'string') {
    addError(`${pointer}.target-branch must be a string`, targetBranchEntry.keyLine);
  }

  const commitMessageEntry = mapEntry(node, 'commit-message');
  if (commitMessageEntry) {
    if (!isMap(commitMessageEntry.value)) {
      addError(`${pointer}.commit-message must be a mapping`, commitMessageEntry.keyLine);
    } else {
      const includeEntry = mapEntry(commitMessageEntry.value, 'include');
      if (includeEntry && !['scope', 'subject'].includes(scalarValue(includeEntry.value))) {
        addError(`${pointer}.commit-message.include must be "scope" or "subject"`, includeEntry.keyLine);
      }
    }
  }

  return {
    index,
    pointer,
    line: node.line,
    endLine: node.endLine,
    ecosystem,
    directoryMode,
    directories,
    directoryLine,
    directoryLines,
    directoryEndLine: (dirsEntry ?? dirEntry)?.value?.endLine ?? line,
    schedule,
    openPullRequestsLimit,
    limitLine: limitEntry?.keyLine ?? null,
    groups,
    groupsLine: groupsEntry?.keyLine ?? null,
    groupsEndLine: groupsEntry?.value?.endLine ?? null,
    ignore,
    ignoreLine: ignoreEntry?.keyLine ?? null,
    ignoreEndLine: ignoreEntry?.value?.endLine ?? null,
    allow,
    allowLine: allowEntry?.keyLine ?? null,
    allowEndLine: allowEntry?.value?.endLine ?? null,
    excludePaths,
    targetBranch: scalarValue(mapEntry(node, 'target-branch')?.value) ?? null,
    raw: node,
  };
}

function root_registriesMissing() {
  // The top-level registries key is validated in parseConfig; a missing key is
  // reported there. This helper exists so the entry-level warning stays cheap.
  return false;
}

function parseGroup(entry, pointer, { addError, addWarning }) {
  const name = entry.key;
  const at = `${pointer}.groups["${name}"]`;
  const nameProblem = /^[A-Za-z](?:[A-Za-z0-9 _|\-]*[A-Za-z0-9])?$/.test(name)
    ? null
    : 'group names must start and end with a letter and may only contain letters, digits, spaces, "|", "_" and "-"';
  if (nameProblem) addError(`${at}: ${nameProblem}`, entry.keyLine);
  if (!isMap(entry.value)) {
    addError(`${at} must be a mapping of rules`, entry.keyLine);
    return null;
  }
  for (const ruleEntry of entry.value.entries) {
    if (!GROUP_KEYS.includes(ruleEntry.key)) {
      addWarning(`${at}: unknown rule "${ruleEntry.key}" (ignored by dependabot)`, ruleEntry.keyLine);
    }
  }
  const patternsEntry = mapEntry(entry.value, 'patterns');
  const patterns = patternsEntry ? stringList(patternsEntry.value) : null;
  if (patternsEntry && patterns === undefined) addError(`${at}.patterns must be a list of strings`, patternsEntry.keyLine);
  const excludeEntry = mapEntry(entry.value, 'exclude-patterns');
  const excludePatterns = excludeEntry ? stringList(excludeEntry.value) : null;
  if (excludeEntry && excludePatterns === undefined) addError(`${at}.exclude-patterns must be a list of strings`, excludeEntry.keyLine);
  const updateTypesEntry = mapEntry(entry.value, 'update-types');
  const updateTypes = updateTypesEntry ? stringList(updateTypesEntry.value) : null;
  if (updateTypesEntry) {
    if (updateTypes === undefined) addError(`${at}.update-types must be a list of strings`, updateTypesEntry.keyLine);
    else {
      for (const value of updateTypes) {
        if (!isUpdateType(value)) {
          addWarning(
            `${at}.update-types entry "${value}" is not one of ${UPDATE_TYPE_VALUES.join(', ')} (accepted as written)`,
            updateTypesEntry.keyLine,
          );
        }
      }
    }
  }
  const appliesToEntry = mapEntry(entry.value, 'applies-to');
  const appliesTo = appliesToEntry ? scalarValue(appliesToEntry.value) : null;
  if (appliesToEntry && !['version-updates', 'security-updates'].includes(appliesTo)) {
    addError(`${at}.applies-to must be "version-updates" or "security-updates"`, appliesToEntry.keyLine);
  }
  const dependencyTypeEntry = mapEntry(entry.value, 'dependency-type');
  const dependencyType = dependencyTypeEntry ? scalarValue(dependencyTypeEntry.value) : null;
  if (dependencyTypeEntry && !['production', 'development'].includes(dependencyType)) {
    addError(`${at}.dependency-type must be "production" or "development"`, dependencyTypeEntry.keyLine);
  }

  return {
    name,
    line: entry.keyLine,
    endLine: entry.value.endLine,
    patterns: patterns ?? null,
    excludePatterns: excludePatterns ?? null,
    updateTypes: updateTypes ? updateTypes.map(canonicalUpdateType) : null,
    rawUpdateTypes: updateTypes ?? null,
    appliesTo: appliesTo ?? 'version-updates',
    dependencyType: dependencyType ?? null,
    groupBy: scalarValue(mapEntry(entry.value, 'group-by')?.value) ?? null,
  };
}

function parseIgnoreRule(item, pointer, index, { addError }) {
  const at = `${pointer}.ignore[${index}]`;
  if (!isMap(item.value)) {
    addError(`${at} must be a mapping with "dependency-name"`, item.line);
    return null;
  }
  for (const entry of item.value.entries) {
    if (!IGNORE_KEYS.includes(entry.key)) addError(`${at}: unknown key "${entry.key}"`, entry.keyLine);
  }
  const nameEntry = mapEntry(item.value, 'dependency-name');
  if (!nameEntry) {
    addError(`${at} is missing required key "dependency-name"`, item.line);
    return null;
  }
  const dependencyName = scalarValue(nameEntry.value);
  if (typeof dependencyName !== 'string' || dependencyName === '') {
    addError(`${at}.dependency-name must be a non-empty string`, nameEntry.keyLine);
    return null;
  }
  const versionsEntry = mapEntry(item.value, 'versions');
  const versions = versionsEntry ? stringList(versionsEntry.value) : [];
  if (versionsEntry && versions === undefined) addError(`${at}.versions must be a list of strings`, versionsEntry.keyLine);
  const updateTypesEntry = mapEntry(item.value, 'update-types');
  const updateTypes = updateTypesEntry ? stringList(updateTypesEntry.value) : [];
  if (updateTypesEntry) {
    if (updateTypes === undefined) addError(`${at}.update-types must be a list of strings`, updateTypesEntry.keyLine);
    else {
      for (const value of updateTypes) {
        if (!isUpdateType(value)) {
          addWarning(
            `${at}.update-types entry "${value}" is not one of ${UPDATE_TYPE_VALUES.join(', ')} (accepted as written)`,
            updateTypesEntry.keyLine,
          );
        }
      }
    }
  }
  return {
    index,
    pointer: at,
    line: item.line,
    endLine: item.value.endLine,
    dependencyName,
    versions: versions ?? [],
    updateTypes: (updateTypes ?? []).map(canonicalUpdateType),
    rawUpdateTypes: updateTypes ?? [],
    keyLine: nameEntry.keyLine,
  };
}

function parseAllowRule(item, pointer, index, { addError, addWarning }) {
  const at = `${pointer}.allow[${index}]`;
  if (!isMap(item.value)) {
    addError(`${at} must be a mapping`, item.line);
    return null;
  }
  for (const entry of item.value.entries) {
    if (!ALLOW_KEYS.includes(entry.key)) addWarning(`${at}: unknown key "${entry.key}" (ignored by dependabot)`, entry.keyLine);
  }
  const nameEntry = mapEntry(item.value, 'dependency-name');
  const dependencyName = nameEntry ? scalarValue(nameEntry.value) : null;
  if (nameEntry && typeof dependencyName !== 'string') addError(`${at}.dependency-name must be a string`, nameEntry.keyLine);
  const typeEntry = mapEntry(item.value, 'dependency-type');
  const dependencyType = typeEntry ? scalarValue(typeEntry.value) : null;
  if (typeEntry && !['direct', 'indirect', 'production', 'development', 'all'].includes(dependencyType)) {
    addError(`${at}.dependency-type must be one of direct, indirect, production, development, all`, typeEntry.keyLine);
  }
  const updateTypeEntry = mapEntry(item.value, 'update-type');
  const updateTypesEntry = mapEntry(item.value, 'update-types');
  return {
    index,
    pointer: at,
    line: item.line,
    endLine: item.value.endLine,
    dependencyName: typeof dependencyName === 'string' ? dependencyName : null,
    dependencyType: typeof dependencyType === 'string' ? dependencyType : 'all',
    updateType: updateTypeEntry ? scalarValue(updateTypeEntry.value) : null,
    updateTypes: updateTypesEntry ? stringList(updateTypesEntry.value) ?? [] : [],
  };
}

/** "/" for root, otherwise "/a/b" with no trailing slash. */
export function normalizeDirectory(dir) {
  let out = String(dir).trim();
  if (!out.startsWith('/')) out = `/${out}`;
  out = out.replace(/\/{2,}/g, '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}
