// Test helpers: build an in-memory repo view (no fs), and small config builders.

import { deriveDirectories } from '../core/deps/index.js';

/**
 * @param {Record<string, string|object>} files path -> content (objects are JSON.stringify'd)
 */
export function viewOf(files, root = '.') {
  const map = new Map();
  for (const [path, content] of Object.entries(files)) {
    map.set(path.replace(/^\//, ''), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  const filePaths = [...map.keys()];
  return {
    root,
    directories: deriveDirectories(filePaths),
    filePaths,
    read(path) {
      const key = String(path).replace(/^\//, '');
      return map.has(key) ? map.get(key) : null;
    },
  };
}

/** A dependabot.yml with the given `updates` YAML body. */
export function configOf(updatesYaml, extra = '') {
  return `version: 2\nupdates:\n${updatesYaml}${extra}`;
}

/** Analyze a config against a fixture tree. */
export function run(configText, files) {
  return analyzeWith(configText, viewOf(files));
}

export function analyzeWith(configText, view) {
  // Imported lazily so tests that only exercise the parser stay cheap.
  return import('../core/analyze.js').then((mod) =>
    mod.analyze({ configText, file: '.github/dependabot.yml', view }),
  );
}

/** Async variant of run. */
export async function runAsync(configText, files) {
  const mod = await import('../core/analyze.js');
  return mod.analyze({ configText, file: '.github/dependabot.yml', view: viewOf(files) });
}

/** Convenience: defect codes of a result. */
export function codes(result) {
  return result.defects.map((defect) => defect.code).sort();
}

/** Convenience: defects of one code. */
export function byCode(result, code) {
  return result.defects.filter((defect) => defect.code === code);
}
