// Shared helpers for dependency enumeration.

/**
 * @typedef {object} Dep
 * @property {string} name        display name as written in the manifest/lockfile
 * @property {string} normalized  ecosystem-normalized name used for matching
 * @property {'production'|'development'|'unknown'} type
 * @property {boolean} direct
 * @property {string[]} sources
 */

export function emptySet() {
  return new Map();
}

/** Add or merge a dependency. */
export function addDep(map, name, { type = 'unknown', direct = false, source = null, normalize = (n) => n } = {}) {
  if (typeof name !== 'string') return;
  const cleaned = name.trim();
  if (cleaned === '' || cleaned === '.') return;
  const key = cleaned.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    if (direct) existing.direct = true;
    if (existing.type === 'unknown' && type !== 'unknown') existing.type = type;
    else if (existing.type !== type && type !== 'unknown') existing.type = existing.type;
    if (source && !existing.sources.includes(source)) existing.sources.push(source);
    return;
  }
  map.set(key, {
    name: cleaned,
    normalized: normalize(cleaned),
    type,
    direct,
    sources: source ? [source] : [],
  });
}

/**
 * PEP 503 name normalization — what dependabot-core registers for the `pip`
 * and `uv` package managers (python/lib/dependabot/python.rb:33 and
 * uv/lib/dependabot/uv.rb:46, which call Dependabot::Python::NameNormaliser).
 * Every other ecosystem uses the identity normaliser.
 */
export function pep503(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

/** True for ecosystems where dependabot normalizes names per PEP 503. */
export function usesPep503(ecosystem) {
  return ecosystem === 'pip' || ecosystem === 'uv';
}

/**
 * Extract a package name from a dependency spec string, e.g.
 * "requests[socks]>=2.31; python_version>'3.8'" -> "requests".
 */
export function depSpecName(spec) {
  if (typeof spec !== 'string') return null;
  let text = spec.trim();
  if (text === '') return null;
  const egg = /#egg=([A-Za-z0-9._-]+)/.exec(text);
  if (egg) return egg[1];
  if (/^(git|https?|file|svn|hg|bzr):/.test(text) || text.startsWith('./') || text.startsWith('../')) return null;
  text = text.replace(/^[-*]\s*/, '');
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(text);
  return match ? match[1] : null;
}

/** Classify a version-ish string (used when splitting lockfile keys). */
export function looksLikeVersion(text) {
  return /^\d/.test(text) || /^v\d/.test(text) || text === 'latest';
}

/** Detect a lockfile/name pair that carries no version information at all. */
export function isProbablyRegistryName(name) {
  return /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/.test(name);
}
