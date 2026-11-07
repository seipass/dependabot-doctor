// Docker: image references in Dockerfiles, Containerfiles and compose files.
//
// dependabot's `docker` ecosystem updates image tags in Dockerfiles and
// docker-compose files. Dependency names are the image repository path with the
// registry and tag stripped — the options reference is explicit about this:
//   "<account>.dkr.ecr.../base/foo/bar/ruby:3.1.0-focal-jemalloc" -> "base/foo/bar/ruby"

const DOCKERFILE = /^(?:[Dd]ockerfile|[Cc]ontainerfile)(?:[.\-].*)?$/;
const DOCKERFILE_NAMED = /\.(?:dockerfile|containerfile)$/i;
const COMPOSE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i;

export function collectDocker(ctx, directory) {
  const references = new Set();
  const sources = [];
  const files = ctx.filesUnder(directory);

  for (const relative of files) {
    const base = relative.slice(relative.lastIndexOf('/') + 1);
    if (DOCKERFILE.test(base) || DOCKERFILE_NAMED.test(base)) {
      const text = ctx.read(relative);
      if (text == null) continue;
      sources.push(relative);
      for (const ref of dockerfileImages(text)) references.add(ref);
    } else if (COMPOSE.test(base)) {
      const text = ctx.read(relative);
      if (text == null) continue;
      sources.push(relative);
      for (const ref of composeImages(text)) references.add(ref);
    }
  }

  if (sources.length === 0) {
    return { ok: false, reason: `no Dockerfile, Containerfile or compose file in ${directory}` };
  }

  const deps = [];
  for (const reference of references) {
    const name = imageName(reference);
    if (!name) continue;
    deps.push({ name, type: 'production', direct: true, source: sources[0] });
    // Alias with the registry intact: a rule that spells the image out in full
    // must still match. Extra aliases only make us quieter, never louder.
    if (reference !== name) deps.push({ name: reference, type: 'production', direct: true, source: sources[0] });
  }
  return { ok: true, coverage: 'complete', deps, sources, notes: [] };
}

/** FROM / COPY --from image references in a Dockerfile. */
export function dockerfileImages(text) {
  const out = [];
  const joined = text.replace(/\\\r?\n/g, ' ');
  for (const rawLine of joined.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*#.*$/, '').trim();
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    if (from) {
      const reference = stripTag(from[1]);
      if (reference) out.push(reference);
    }
    const copyFrom = /^COPY\s+.*--from=(\S+)/i.exec(line);
    if (copyFrom && (copyFrom[1].includes('/') || copyFrom[1].includes('.'))) {
      const reference = stripTag(copyFrom[1]);
      if (reference) out.push(reference);
    }
  }
  return out;
}

/** `image:` keys in a compose file. */
export function composeImages(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^\s*(?:-\s*)?image:\s*["']?([^"'\s#]+)["']?/.exec(rawLine);
    if (match) {
      const reference = stripTag(match[1]);
      if (reference) out.push(reference);
    }
  }
  return out;
}

/** Drop the tag/digest from a reference, keeping registry and path. */
export function stripTag(reference) {
  if (typeof reference !== 'string') return null;
  let ref = reference.trim();
  if (ref === '' || ref.includes('$')) return null;
  ref = ref.split('@')[0];
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) ref = ref.slice(0, colon);
  if (ref === '' || ref.toLowerCase() === 'scratch') return null;
  return ref;
}

/**
 * Normalize an image reference the way dependabot names docker dependencies:
 * drop the digest, the tag, and the registry host (when the first segment
 * carries a dot/colon or is "localhost").
 */
export function imageName(reference) {
  if (typeof reference !== 'string') return null;
  let ref = reference.trim();
  if (ref === '' || ref.includes('$')) return null;
  if (ref.toLowerCase() === 'scratch') return null;
  ref = ref.split('@')[0];
  const segments = ref.split('/');
  let repo = segments;
  if (segments.length > 1 && (segments[0].includes('.') || segments[0].includes(':') || segments[0] === 'localhost')) {
    repo = segments.slice(1);
  }
  const last = repo[repo.length - 1];
  const colon = last.indexOf(':');
  if (colon >= 0) repo[repo.length - 1] = last.slice(0, colon);
  const name = repo.join('/');
  if (name === '' || name === 'scratch') return null;
  return name;
}
