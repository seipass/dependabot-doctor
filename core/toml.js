// A small TOML reader — enough for Cargo.toml, pyproject.toml, Pipfile,
// uv.lock and poetry.lock. No dependencies, no surprises: unsupported syntax
// throws, and callers treat a throw as "coverage unknown" (never as a finding).
//
// Supported: tables, arrays of tables, bare/quoted/dotted keys, basic and
// literal strings (single and multi-line), integers, floats, booleans, arrays,
// inline tables, datetimes (kept as strings), comments.

export class TomlError extends Error {
  constructor(message, line) {
    super(line == null ? message : `line ${line}: ${message}`);
    this.name = 'TomlError';
    this.line = line ?? null;
  }
}

class Reader {
  constructor(text) {
    this.s = text;
    this.i = 0;
    this.line = 1;
  }

  get pos() {
    return this.i;
  }

  eof() {
    return this.i >= this.s.length;
  }

  peek(offset = 0) {
    return this.s[this.i + offset];
  }

  next() {
    const ch = this.s[this.i];
    this.i += 1;
    if (ch === '\n') this.line += 1;
    return ch;
  }

  startsWith(text) {
    return this.s.startsWith(text, this.i);
  }

  skipSpaces() {
    while (!this.eof() && (this.peek() === ' ' || this.peek() === '\t')) this.next();
  }

  skipComment() {
    if (this.peek() === '#') {
      while (!this.eof() && this.peek() !== '\n') this.next();
    }
  }

  /** Skip whitespace, comments and newlines. */
  skipTrivia() {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (this.peek() === '\r') {
        this.next();
        continue;
      }
      if (this.peek() === '\n') {
        this.next();
        continue;
      }
      return;
    }
  }

  expect(text) {
    if (!this.startsWith(text)) throw new TomlError(`expected "${text}"`, this.line);
    for (let i = 0; i < text.length; i += 1) this.next();
  }

  readKeyPath() {
    const parts = [];
    for (;;) {
      this.skipSpaces();
      const ch = this.peek();
      if (ch === '"' || ch === "'") {
        parts.push(this.readString());
      } else {
        const match = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i, this.i + 256));
        if (!match) throw new TomlError('expected a key', this.line);
        for (let i = 0; i < match[0].length; i += 1) this.next();
        parts.push(match[0]);
      }
      this.skipSpaces();
      if (this.peek() === '.') {
        this.next();
        continue;
      }
      return parts;
    }
  }

  readString() {
    const quote = this.peek();
    if (quote === '"') {
      if (this.startsWith('"""')) {
        this.expect('"""');
        let out = '';
        while (!this.startsWith('"""')) {
          if (this.eof()) throw new TomlError('unterminated multi-line string', this.line);
          if (this.peek() === '\\') {
            out += this.readEscape();
            continue;
          }
          out += this.next();
        }
        this.expect('"""');
        return out.replace(/^\r?\n/, '');
      }
      this.next();
      let out = '';
      while (!this.eof() && this.peek() !== '"') {
        if (this.peek() === '\n') throw new TomlError('unterminated string', this.line);
        if (this.peek() === '\\') {
          out += this.readEscape();
          continue;
        }
        out += this.next();
      }
      this.expect('"');
      return out;
    }
    if (quote === "'") {
      if (this.startsWith("'''")) {
        this.expect("'''");
        let out = '';
        while (!this.startsWith("'''")) {
          if (this.eof()) throw new TomlError('unterminated multi-line literal string', this.line);
          out += this.next();
        }
        this.expect("'''");
        return out;
      }
      this.next();
      let out = '';
      while (!this.eof() && this.peek() !== "'") {
        if (this.peek() === '\n') throw new TomlError('unterminated literal string', this.line);
        out += this.next();
      }
      this.expect("'");
      return out;
    }
    throw new TomlError('expected a string', this.line);
  }

  readEscape() {
    this.expect('\\');
    const ch = this.next();
    const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' };
    if (Object.hasOwn(simple, ch)) return simple[ch];
    if (ch === 'u' || ch === 'U') {
      const length = ch === 'u' ? 4 : 8;
      const hex = this.s.slice(this.i, this.i + length);
      if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) throw new TomlError('bad unicode escape', this.line);
      for (let i = 0; i < length; i += 1) this.next();
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (ch === '\n' || ch === '\r') {
      // line-ending backslash: trim following whitespace
      while (!this.eof() && /\s/.test(this.peek())) this.next();
      return '';
    }
    throw new TomlError(`unknown escape \\${ch}`, this.line);
  }

  readValue() {
    this.skipSpaces();
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.readString();
    if (ch === '[') return this.readArray();
    if (ch === '{') return this.readInlineTable();
    if (this.startsWith('true')) {
      this.expect('true');
      return true;
    }
    if (this.startsWith('false')) {
      this.expect('false');
      return false;
    }
    // number or datetime: read the token
    const rest = this.s.slice(this.i, this.i + 64);
    const match = /^[0-9A-Za-z_:.+-]+/.exec(rest);
    if (!match) throw new TomlError('expected a value', this.line);
    for (let i = 0; i < match[0].length; i += 1) this.next();
    const token = match[0];
    if (/^[+-]?\d+$/.test(token)) return Number(token);
    if (/^[+-]?\d{4}-\d{2}-\d{2}/.test(token)) return token; // datetime, kept as text
    if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) return Number(token);
    if (/^[+-]?(inf|nan)$/.test(token)) return Number(token);
    return token;
  }

  readArray() {
    this.expect('[');
    const out = [];
    for (;;) {
      this.skipTrivia();
      if (this.peek() === ']') {
        this.next();
        return out;
      }
      out.push(this.readValue());
      this.skipTrivia();
      if (this.peek() === ',') {
        this.next();
        continue;
      }
      this.skipTrivia();
      if (this.peek() === ']') {
        this.next();
        return out;
      }
      throw new TomlError('malformed array', this.line);
    }
  }

  readInlineTable() {
    this.expect('{');
    const out = {};
    for (;;) {
      this.skipSpaces();
      if (this.peek() === '}') {
        this.next();
        return out;
      }
      const path = this.readKeyPath();
      this.skipSpaces();
      this.expect('=');
      const value = this.readValue();
      assignPath(out, path, value);
      this.skipSpaces();
      if (this.peek() === ',') {
        this.next();
        continue;
      }
      this.skipSpaces();
      if (this.peek() === '}') {
        this.next();
        return out;
      }
      throw new TomlError('malformed inline table', this.line);
    }
  }
}

function assignPath(target, path, value) {
  let node = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  const last = path[path.length - 1];
  if (Array.isArray(node) && Array.isArray(value) === false && node.length > 0 && typeof node[node.length - 1] === 'object') {
    node[node.length - 1][last] = value;
    return;
  }
  node[last] = value;
}

/**
 * Parse a TOML document into a plain object.
 * @param {string} text
 */
export function parseToml(text) {
  const reader = new Reader(text.replace(/^\uFEFF/, ''));
  const root = {};
  let current = root;
  let currentIsArrayTable = false;

  while (!reader.eof()) {
    reader.skipTrivia();
    if (reader.eof()) break;
    if (reader.peek() === '[') {
      const isArrayTable = reader.peek(1) === '[';
      reader.expect(isArrayTable ? '[[' : '[');
      const path = reader.readKeyPath();
      reader.skipSpaces();
      reader.expect(isArrayTable ? ']]' : ']');
      let node = root;
      for (let i = 0; i < path.length - 1; i += 1) {
        const key = path[i];
        if (node[key] === undefined) node[key] = {};
        node = node[key];
        if (Array.isArray(node)) node = node[node.length - 1];
        if (typeof node !== 'object' || node === null) throw new TomlError(`key "${key}" is not a table`, reader.line);
      }
      const last = path[path.length - 1];
      if (isArrayTable) {
        if (!Array.isArray(node[last])) node[last] = [];
        const table = {};
        node[last].push(table);
        current = table;
      } else {
        if (node[last] === undefined) node[last] = {};
        if (Array.isArray(node[last])) node[last] = node[last][node[last].length - 1] ?? {};
        current = node[last];
      }
      currentIsArrayTable = isArrayTable;
      reader.skipSpaces();
      reader.skipComment();
      continue;
    }
    const path = reader.readKeyPath();
    reader.skipSpaces();
    reader.expect('=');
    const value = reader.readValue();
    if (currentIsArrayTable && Array.isArray(current) === false && current && typeof current === 'object') {
      assignPath(current, path, value);
    } else {
      assignPath(current, path, value);
    }
    reader.skipSpaces();
    reader.skipComment();
  }
  return root;
}
