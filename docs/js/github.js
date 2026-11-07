// Transport. Two hosts, and nothing else — ever.
//
//   raw.githubusercontent.com   file bodies; CORS: Access-Control-Allow-Origin *
//   api.github.com              ONE call, only when a config uses a glob
//                               `directories:` that cannot be expanded otherwise
//
// Deliberately absent: a token field, credentials, cookies, a proxy, a worker,
// any third-party host. `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`
// are set on every request so the sentence on the page stays true even for a
// visitor who is signed in to GitHub in the same browser.
//
// Cache: module-scoped, in memory only. Nothing is written to localStorage,
// sessionStorage, IndexedDB or a cookie — the page says "Nothing is stored" and
// that has to be literally true, so repeat checks in the same tab cost zero
// requests and closing the tab clears everything.

export const RAW_BASE = 'https://raw.githubusercontent.com';
export const API_BASE = 'https://api.github.com';

/** Raw returns 206 for a Range request even when the file is smaller than the
 *  range, so the total cannot be read from Content-Range (not CORS-exposed).
 *  Content-Length is CORS-safelisted, and this is the rule that follows from
 *  what we can actually see: a slice shorter than the cap is the whole file. */
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 5 * 60 * 1000; // mirrors raw's own Cache-Control: max-age=300

const memo = new Map();
export const stats = { raw: 0, api: 0 };

export function resetCache() {
  memo.clear();
  stats.raw = 0;
  stats.api = 0;
}

export function noteForTest(...args) {
  const [key, value] = args;
  memo.set(key, value);
}

/** Accepts owner/repo, github.com/owner/repo, https://…/owner/repo(.git). */
export function parseRepoInput(input) {
  const text = String(input ?? '').trim();
  if (text === '') return null;
  const cleaned = text
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})$/.exec(cleaned);
  if (!match) return null;
  if (match[2] === '.' || match[2] === '..') return null;
  return { owner: match[1], repo: match[2] };
}

/** Looks like YAML rather than a repo name — used to route paste-into-field. */
export function looksLikeYaml(text) {
  const value = String(text ?? '');
  if (value.includes('\n')) return true;
  return /^\s*(---|version:|updates:|#)/m.test(value) && !/^[\w.-]+\/[\w.-]+$/.test(value.trim());
}

function fresh(key) {
  const hit = memo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    memo.delete(key);
    return null;
  }
  return hit.value;
}

function remember(key, value) {
  memo.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Fetch one file body.
 * @returns {Promise<{kind:'ok'|'missing'|'too-large'|'refused'|'offline', text?:string, status?:number}>}
 */
export async function rawFile({ owner, repo, ref = 'HEAD', path, signal }) {
  const key = `raw|${owner}/${repo}@${ref}|${path}`;
  const cached = fresh(key);
  if (cached) return cached;

  const url = `${RAW_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${ref}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

  let response;
  try {
    stats.raw += 1;
    response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Range: `bytes=0-${MAX_BYTES - 1}` },
      signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    return remember(key, { kind: 'offline' });
  }

  if (response.status === 404) return remember(key, { kind: 'missing', status: 404 });
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    return remember(key, { kind: 'refused', status: response.status });
  }
  if (!response.ok) return remember(key, { kind: 'refused', status: response.status });

  const length = Number(response.headers.get('content-length') ?? '0');
  const ranged = response.status === 206;
  if (ranged && length >= MAX_BYTES) {
    // We were handed exactly the slice we asked for: either the file is at
    // least that big (truncated) or it is exactly that big. Either way we do
    // not half-read it — the page reports the size limit instead.
    return remember(key, { kind: 'too-large', status: 206 });
  }

  let text;
  try {
    text = await response.text();
  } catch {
    return remember(key, { kind: 'offline' });
  }
  if (ranged && length > 0 && new TextEncoder().encode(text).length < length) {
    // A multi-byte file can decode shorter than its byte length; only a short
    // read against Content-Length indicates truncation.
    if (text.length * 4 < length) return remember(key, { kind: 'too-large', status: 206 });
  }
  return remember(key, { kind: 'ok', text, status: response.status });
}

/**
 * The file list. One call, per repo, and only for a config the page cannot
 * expand without it. `remaining` is returned so the caller can say what the
 * quota looks like; it is never invented when the header is absent.
 */
export async function fileList({ owner, repo, ref = 'HEAD', signal }) {
  const key = `tree|${owner}/${repo}@${ref}`;
  const cached = fresh(key);
  if (cached) return cached;

  const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(
    ref,
  )}?recursive=1`;

  let response;
  try {
    stats.api += 1;
    response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/vnd.github+json' },
      signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    return remember(key, { kind: 'offline' });
  }

  const remainingHeader = response.headers.get('x-ratelimit-remaining');
  const remaining = remainingHeader == null || remainingHeader === '' ? null : Number(remainingHeader);

  if (response.status === 403 || response.status === 429) {
    return remember(key, { kind: 'refused', status: response.status, remaining });
  }
  if (response.status === 404) return remember(key, { kind: 'missing', status: 404, remaining });
  if (!response.ok) return remember(key, { kind: 'refused', status: response.status, remaining });

  let data;
  try {
    data = await response.json();
  } catch {
    return remember(key, { kind: 'offline', remaining });
  }
  const paths = (Array.isArray(data.tree) ? data.tree : [])
    .filter((item) => item && item.type === 'blob' && typeof item.path === 'string')
    .map((item) => item.path);

  // `truncated` means GitHub capped the listing; a partial list would make
  // "this directory does not exist" a guess, so it is not treated as full.
  return remember(key, {
    kind: data.truncated ? 'truncated' : 'ok',
    paths,
    remaining,
    tree: data.sha ?? null,
  });
}
