// CLI: filesystem + argv + exit codes. All the judgement lives in core/.
//
// Read-only by construction: this file opens files for reading and prints to
// stdout/stderr. There is no write path anywhere in the package.

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { analyze, VERSION } from '../core/analyze.js';
import { serialize, exitCodeFor } from '../core/report/json.js';
import { renderText } from '../core/report/text.js';
import { scanTree } from './fs.js';

const USAGE = `dependabot-doctor ${VERSION}
Find groups, ignore rules and directory globs in .github/dependabot.yml that
match nothing. Offline. Read-only. No token.

Usage
  dependabot-doctor [path] [options]

  path                    repository to inspect (default: current directory)

Options
  --config <file>         config to lint (default: <path>/.github/dependabot.yml;
                          "-" reads the config from stdin)
  --json                  machine-readable output
  --fail-on <codes>       comma-separated defect codes that fail the run
                          (default: all = every error/warning; "none" never fails)
  --no-color              disable ANSI colour
  --patch                 also print the suggested patch (never written)
  --quiet                 suppress the header lines, keep findings
  --version               print the version
  --help                  print this help

Exit codes
  0  no findings that match --fail-on
  2  findings
  1  usage error, unreadable config, or a config GitHub would reject

Defect codes
  no-op-group       a group can never contain a dependency
  ignore-no-match   an ignore rule matches no dependency
  directory-no-match  a directory/glob matches no directory in this checkout
  ecosystem-absent  an ecosystem is configured where no manifest exists
  flood-risk        daily + ungrouped + capped PRs cannot drain the queue
`;

export function main(argv = process.argv.slice(2)) {
  const options = {
    path: '.',
    config: null,
    json: false,
    failOn: 'all',
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    patch: false,
    quiet: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (arg === '--version' || arg === '-v') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--no-color' || arg === '--no-colour') {
      options.color = false;
      continue;
    }
    if (arg === '--patch') {
      options.patch = true;
      continue;
    }
    if (arg === '--no-patch') {
      options.patch = false;
      continue;
    }
    if (arg === '--quiet') {
      options.quiet = true;
      continue;
    }
    if (arg === '--config') {
      options.config = argv[i + 1];
      i += 1;
      if (!options.config) {
        process.stderr.write('error: --config needs a file path\n');
        return 1;
      }
      continue;
    }
    if (arg.startsWith('--config=')) {
      options.config = arg.slice('--config='.length);
      continue;
    }
    if (arg === '--fail-on') {
      options.failOn = argv[i + 1] ?? 'all';
      i += 1;
      continue;
    }
    if (arg.startsWith('--fail-on=')) {
      options.failOn = arg.slice('--fail-on='.length);
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      process.stderr.write(`error: unknown option ${arg}\nTry --help.\n`);
      return 1;
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    process.stderr.write('error: expected at most one path argument\n');
    return 1;
  }
  const root = resolve(positional[0] ?? '.');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`error: not a directory: ${root}\n`);
    return 1;
  }

  const configPath = options.config ?? findConfig(root);
  if (!configPath) {
    process.stderr.write(
      `error: no .github/dependabot.yml (or .yaml) found under ${root}\nnothing to lint - pass --config <file> if it lives elsewhere\n`,
    );
    return 1;
  }

  let configText;
  try {
    configText = options.config === '-' ? readFileSync(0, 'utf8') : readFileSync(configPath, 'utf8');
  } catch (error) {
    process.stderr.write(`error: cannot read ${configPath}: ${error.message}\n`);
    return 1;
  }

  const tree = scanTree(root);
  const view = {
    root,
    directories: tree.directories,
    filePaths: [...tree.files].flatMap(([directory, names]) =>
      [...names].map((name) => (directory === '/' ? name : `${directory.slice(1)}/${name}`)),
    ),
    read(relativePath) {
      try {
        return readFileSync(join(root, ...relativePath.split('/')), 'utf8');
      } catch {
        return null;
      }
    },
  };

  let result;
  try {
    result = analyze({
      configText,
      file: options.config === '-' ? '.github/dependabot.yml' : displayPath(root, configPath),
      view,
    });
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    if (process.env.DEBUG) process.stderr.write(`${error.stack}\n`);
    return 1;
  }

  if (options.json) {
    const payload = serialize(result);
    payload.exit = exitCodeFor(result, options.failOn);
    payload.truncated = tree.truncated;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload.exit;
  }

  const text = renderText(result, {
    patch: options.patch,
    source: options.config === '-' ? null : configText,
  });
  process.stdout.write(`${options.quiet ? '' : ''}${text}\n`);
  if (tree.truncated) {
    process.stderr.write('note: the checkout is very large and the file scan was capped; directory checks may be incomplete\n');
  }
  return exitCodeFor(result, options.failOn);
}

function findConfig(root) {
  for (const name of ['.github/dependabot.yml', '.github/dependabot.yaml']) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function displayPath(root, absolute) {
  const normalized = absolute.replace(/\\/g, '/');
  const base = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1);
  return normalized;
}

export { USAGE };
