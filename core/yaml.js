// Minimal, dependency-free YAML reader for dependabot.yml.
//
// Why not use a library: this package must run from a single downloaded file on
// a cold machine (`npx` is not available to us, and we refuse a runtime
// dependency graph). The subset below is the subset dependabot.yml lives in:
// block mappings, block sequences, flow sequences/maps, quoted and plain
// scalars. Anything else (anchors, aliases, tags, block scalars) is rejected
// loudly rather than guessed at — a wrong parse here would produce a wrong
// finding, which is the one failure mode that matters.
//
// Every node carries line numbers so findings can cite the exact line.

export class YamlError extends Error {
  /**
   * @param {string} message
   * @param {number|null} line
   * @param {'invalid'|'unsupported'} kind `invalid` = a violation of the YAML
   *   grammar; `unsupported` = valid YAML this reader does not implement. The
   *   distinction decides whether we blame the file or ourselves, and only the
   *   `invalid` wording is allowed to say the file is not valid YAML.
   */
  constructor(message, line, kind = 'invalid') {
    super(line == null ? message : `line ${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line == null ? null : line;
    this.kind = kind;
  }
}

/** Remove a trailing `#` comment, respecting quoted strings. */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") {
        if (line[i + 1] === "'") i += 1;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** Depth of `[`/`{` nesting outside of quotes. Negative means "too many closes". */
function flowDepth(text) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i += 1;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
  }
  return depth;
}

/**
 * Split raw text into logical lines: { indent, text, line, endLine }.
 * Multi-line flow collections are joined into one logical line.
 */
function toLogicalLines(source) {
  const rawLines = source.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const out = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    const withoutComment = stripComment(raw);
    const text = withoutComment.replace(/\s+$/, '');
    if (text.trim() === '') continue;
    const lead = /^[ \t]*/.exec(text)[0];
    if (lead.includes('\t')) {
      throw new YamlError('tab character used for indentation (YAML requires spaces)', i + 1);
    }
    const indent = lead.length;
    const body = text.slice(indent);
    let depth = flowDepth(body);
    const line = i + 1;
    let joined = body;
    while (depth > 0) {
      i += 1;
      if (i >= rawLines.length) throw new YamlError('unterminated flow collection', line);
      const nextText = stripComment(rawLines[i]).trim();
      joined += ` ${nextText}`;
      depth = flowDepth(joined);
    }
    if (depth < 0) throw new YamlError('unbalanced flow collection', line);
    out.push({ indent, text: joined, line, endLine: i + 1 });
  }
  return out;
}

/** Find the index of the `:` that ends a block mapping key, or -1. */
function findKeyColon(text) {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i += 1;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ':' && depth === 0) {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

function unquoteKey(key) {
  const trimmed = key.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'")) {
    return parseQuoted(trimmed, 0).value;
  }
  return trimmed;
}

/** Parse a quoted scalar starting at `start`; returns { value, next }. */
function parseQuoted(text, start) {
  const quote = text[start];
  if (quote === "'") {
    let out = '';
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, next: i + 1 };
      }
      out += text[i];
      i += 1;
    }
    throw new YamlError('unterminated single-quoted string');
  }
  let out = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const esc = text[i + 1];
      const simple = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ' };
      if (Object.hasOwn(simple, esc)) {
        out += simple[esc];
        i += 2;
        continue;
      }
      if (esc === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new YamlError('bad \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      throw new YamlError(`unsupported escape sequence \\${esc}`);
    }
    if (ch === '"') return { value: out, next: i + 1 };
    out += ch;
    i += 1;
  }
  throw new YamlError('unterminated double-quoted string');
}

function resolvePlain(text) {
  const value = text.trim();
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(value)) return true;
  if (/^(false|False|FALSE)$/.test(value)) return false;
  if (/^[+-]?\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Parse a flow collection or a scalar from a complete logical line body. */
function parseInline(text, line, endLine, anchors) {
  const trimmed = text.trim();
  if (trimmed.startsWith('*')) {
    const name = trimmed.slice(1).trim();
    if (!anchors || !anchors.has(name)) throw new YamlError(`unknown YAML alias "*${name}"`, line);
    return cloneNode(anchors.get(name));
  }
  if (trimmed.startsWith('&')) {
    const match = /^&(\S+)\s*(.*)$/.exec(trimmed);
    if (!match) throw new YamlError('malformed YAML anchor', line);
    const value = match[2] === '' ? { type: 'scalar', line, endLine, value: null, raw: '' } : parseInline(match[2], line, endLine, anchors);
    if (anchors) anchors.set(match[1], value);
    return value;
  }
  if (trimmed.startsWith('!')) throw new YamlError('YAML tags are not supported', line, 'unsupported');
  if (trimmed.startsWith('|') || trimmed.startsWith('>')) {
    throw new YamlError('YAML block scalars (| or >) are not supported by this reader', line, 'unsupported');
  }
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = parseFlow(trimmed, 0, line, endLine, anchors);
    if (parsed.next !== trimmed.length) throw new YamlError('trailing content after flow collection', line);
    return parsed.value;
  }
  const node = { type: 'scalar', line, endLine, value: null, raw: trimmed };
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const parsed = parseQuoted(trimmed, 0);
    if (parsed.next !== trimmed.length) throw new YamlError('trailing content after quoted string', line);
    node.value = parsed.value;
  } else {
    node.value = resolvePlain(trimmed);
  }
  return node;
}

function parseFlow(text, start, line, endLine, anchors) {
  let i = start;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  skipSpace();
  const ch = text[i];
  if (ch === '[') {
    const node = { type: 'seq', line, endLine, items: [] };
    i += 1;
    for (;;) {
      skipSpace();
      if (text[i] === ']') {
        i += 1;
        return { value: node, next: i };
      }
      const inner = parseFlow(text, i, line, endLine, anchors);
      node.items.push({ line, value: inner.value });
      i = inner.next;
      skipSpace();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return { value: node, next: i };
      }
      throw new YamlError('malformed flow sequence', line);
    }
  }
  if (ch === '{') {
    const node = { type: 'map', line, endLine, entries: [], duplicateKeys: [] };
    i += 1;
    for (;;) {
      skipSpace();
      if (text[i] === '}') {
        i += 1;
        return { value: node, next: i };
      }
      const keyStart = i;
      let key;
      if (text[i] === '"' || text[i] === "'") {
        const parsed = parseQuoted(text, i);
        key = parsed.value;
        i = parsed.next;
      } else {
        while (i < text.length && text[i] !== ':' && text[i] !== ',' && text[i] !== '}') i += 1;
        key = text.slice(keyStart, i).trim();
      }
      skipSpace();
      let value = { type: 'scalar', line, endLine, value: null, raw: '' };
      if (text[i] === ':') {
        i += 1;
        skipSpace();
        const inner = parseFlow(text, i, line, endLine, anchors);
        value = inner.value;
        i = inner.next;
      }
      if (node.entries.some((e) => e.key === key)) node.duplicateKeys.push(key);
      node.entries.push({ key, keyLine: line, value });
      skipSpace();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return { value: node, next: i };
      }
      throw new YamlError('malformed flow mapping', line);
    }
  }
  if (ch === '"' || ch === "'") {
    const parsed = parseQuoted(text, i);
    return {
      value: { type: 'scalar', line, endLine, value: parsed.value, raw: text.slice(i, parsed.next) },
      next: parsed.next,
    };
  }
  const startIdx = i;
  while (i < text.length && !',]}'.includes(text[i])) i += 1;
  const raw = text.slice(startIdx, i).trim();
  return { value: { type: 'scalar', line, endLine, value: resolvePlain(raw), raw }, next: i };
}

class Parser {
  constructor(lines) {
    this.lines = lines;
    this.i = 0;
    this.lastLine = 0;
    /** YAML anchors, so `schedule: *weekly` works. */
    this.anchors = new Map();
  }

  peek() {
    return this.lines[this.i];
  }

  parseBlock(minIndent) {
    const next = this.peek();
    if (!next || next.indent < minIndent) return null;
    if (next.text === '-' || next.text.startsWith('- ')) return this.parseSeq(next.indent);
    // A flow collection indented under a key is a value, not a mapping:
    //     update-types:
    //       ['version-update:semver-patch']
    if ((next.text.startsWith('[') || next.text.startsWith('{')) && findKeyColon(next.text) < 0) {
      this.i += 1;
      return parseInline(next.text, next.line, next.endLine);
    }
    return this.parseMap(next.indent);
  }

  parseMap(indent) {
    const first = this.peek();
    const node = { type: 'map', line: first.line, endLine: first.endLine, entries: [], duplicateKeys: [] };
    while (this.i < this.lines.length) {
      const cur = this.peek();
      if (cur.indent < indent) break;
      if (cur.indent > indent) {
        throw new YamlError(`unexpected indentation (expected ${indent} spaces)`, cur.line);
      }
      if (cur.text === '-' || cur.text.startsWith('- ')) break;
      const colon = findKeyColon(cur.text);
      if (colon < 0) throw new YamlError(`expected "key: value", found "${cur.text}"`, cur.line);
      const key = unquoteKey(cur.text.slice(0, colon));
      let rest = cur.text.slice(colon + 1).trim();
      let anchorName = null;
      const anchorMatch = /^&(\S+)\s*(.*)$/.exec(rest);
      if (anchorMatch) {
        anchorName = anchorMatch[1];
        rest = anchorMatch[2];
      }
      this.i += 1;
      let value;
      if (rest === '') {
        // YAML allows a block sequence to sit at the same indentation as its
        // parent key, which is the shape Dependabot's own template uses:
        //     updates:
        //     - package-ecosystem: npm
        const next = this.peek();
        let nested = null;
        if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
          nested = this.parseSeq(indent);
        } else {
          nested = this.parseBlock(indent + 1);
        }
        if (nested) {
          value = nested;
          this.lastLine = nested.endLine;
        } else {
          value = { type: 'scalar', line: cur.line, endLine: cur.line, value: null, raw: '' };
          this.lastLine = cur.line;
        }
      } else {
        // Plain scalars may be folded across more-indented continuation lines.
        let text = rest;
        let endLine = cur.endLine;
        while (
          this.i < this.lines.length &&
          this.peek().indent > indent &&
          !/^["'[{]/.test(this.peek().text) &&
          findKeyColon(this.peek().text) < 0 &&
          !(this.peek().text === '-' || this.peek().text.startsWith('- '))
        ) {
          text += ` ${this.peek().text}`;
          endLine = this.peek().endLine;
          this.i += 1;
        }
        if (this.i < this.lines.length && this.peek().indent > indent) {
          const bad = this.peek();
          throw new YamlError('unexpected indentation after a scalar value', bad.line);
        }
        value = parseInline(text, cur.line, endLine, this.anchors);
        this.lastLine = value.endLine;
      }
      if (anchorName) this.anchors.set(anchorName, value);
      if (key === '<<' && value && value.type === 'map') {
        // YAML merge key: pull the anchored mapping's entries in place.
        for (const merged of value.entries) {
          if (!node.entries.some((e) => e.key === merged.key)) node.entries.push({ ...merged });
        }
        node.endLine = this.lastLine;
        continue;
      }
      if (node.entries.some((e) => e.key === key)) node.duplicateKeys.push(key);
      node.entries.push({ key, keyLine: cur.line, value });
      node.endLine = this.lastLine;
    }
    return node;
  }

  parseSeq(indent) {
    const first = this.peek();
    const node = { type: 'seq', line: first.line, endLine: first.endLine, items: [] };
    while (this.i < this.lines.length) {
      const cur = this.peek();
      if (cur.indent !== indent) break;
      if (!(cur.text === '-' || cur.text.startsWith('- '))) break;
      let rest = cur.text === '-' ? '' : cur.text.slice(1).trim();
      const offset = cur.text.length - cur.text.slice(1).trimStart().length;
      let anchorName = null;
      const anchorMatch = /^&(\S+)\s*(.*)$/.exec(rest);
      if (anchorMatch) {
        anchorName = anchorMatch[1];
        rest = anchorMatch[2];
      }
      if (rest === '') {
        this.i += 1;
        const nested = this.parseBlock(indent + 1);
        const value = nested ?? { type: 'scalar', line: cur.line, endLine: cur.line, value: null, raw: '' };
        node.items.push({ line: cur.line, value });
        this.lastLine = value.endLine;
      } else if (findKeyColon(rest) >= 0) {
        // "- key: value" starts a mapping whose indentation is the key column.
        this.lines[this.i] = { indent: indent + offset, text: rest, line: cur.line, endLine: cur.endLine };
        const nested = this.parseMap(indent + offset);
        node.items.push({ line: cur.line, value: nested });
        this.lastLine = nested.endLine;
      } else {
        this.i += 1;
        const value = parseInline(rest, cur.line, cur.endLine, this.anchors);
        node.items.push({ line: cur.line, value });
        this.lastLine = value.endLine;
      }
      if (anchorName) this.anchors.set(anchorName, node.items[node.items.length - 1].value);
      node.endLine = this.lastLine;
    }
    return node;
  }
}

/**
 * Parse a YAML document into a node tree.
 * @param {string} source
 */
export function parseYaml(source) {
  // Optional document markers. `---` may open the document; `...` may close it.
  const lines = toLogicalLines(source).filter((line, index, all) => {
    if (line.text === '---') return false;
    if (line.text === '...' && index === all.length - 1) return false;
    return true;
  });
  if (lines.length === 0) return { type: 'scalar', line: 1, endLine: 1, value: null, raw: '' };
  const parser = new Parser(lines);
  const node = parser.parseBlock(0);
  if (!node) throw new YamlError('empty document');
  if (parser.i < lines.length) {
    const rest = parser.peek();
    throw new YamlError(
      `unexpected content "${rest.text.slice(0, 40)}" (multiple documents are not supported)`,
      rest.line,
      'unsupported',
    );
  }
  return node;
}

/** Deep copy a node (aliases must not share structure with their anchor). */
function cloneNode(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(cloneNode);
  const out = {};
  for (const [key, value] of Object.entries(node)) out[key] = cloneNode(value);
  return out;
}

/** Get a value node by key from a map node, or undefined. */
export function mapGet(node, key) {
  if (!node || node.type !== 'map') return undefined;
  const entry = node.entries.find((e) => e.key === key);
  return entry ? entry.value : undefined;
}

/** Get the entry record (with keyLine) from a map node. */
export function mapEntry(node, key) {
  if (!node || node.type !== 'map') return undefined;
  return node.entries.find((e) => e.key === key);
}

/** Convert a node tree to plain JavaScript values. */
export function toPlain(node) {
  if (!node) return null;
  if (node.type === 'map') {
    const out = {};
    for (const entry of node.entries) out[entry.key] = toPlain(entry.value);
    return out;
  }
  if (node.type === 'seq') return node.items.map((item) => toPlain(item.value));
  return node.value;
}
