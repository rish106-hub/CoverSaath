// Rewrites SQLite-style `?` placeholders to PostgreSQL `$n` (S3.2 design, decision 6).
//
// A `?` is a placeholder only in plain SQL text. It is left alone inside single-quoted strings
// ('' escapes; E'' strings also honour backslash escapes), double-quoted identifiers ("" escapes),
// dollar-quoted bodies ($$ … $$ and $tag$ … $tag$), `--` line comments and `/* */` block comments
// (which nest in PostgreSQL). Positional `$1` parameters in plain text are refused: mixing the two
// styles would silently renumber parameters. Unterminated quotes or comments are refused too.
import { PostgresDatabaseError } from './errors.js';

const identifierStart = /[A-Za-z_\u0080-￿]/;
const identifierPart = /[A-Za-z0-9_\u0080-￿$]/;

function invalid(message) {
  return new PostgresDatabaseError('DATABASE_SQL_INVALID', message);
}

// Returns the dollar-quote tag that starts at `index` (`$$` or `$tag$`), or null.
function dollarTagAt(sql, index) {
  if (sql[index] !== '$') return null;
  if (index > 0 && identifierPart.test(sql[index - 1])) return null;
  let end = index + 1;
  if (sql[end] === '$') return '$$';
  if (!identifierStart.test(sql[end] ?? '')) return null;
  while (end < sql.length && /[A-Za-z0-9_\u0080-￿]/.test(sql[end])) end += 1;
  return sql[end] === '$' ? sql.slice(index, end + 1) : null;
}

function skipQuoted(sql, start, quote, { backslashEscapes = false } = {}) {
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (backslashEscapes && char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  throw invalid(quote === '"' ? 'SQL has an unterminated quoted identifier.' : 'SQL has an unterminated string literal.');
}

function skipBlockComment(sql, start) {
  let depth = 0;
  let index = start;
  while (index < sql.length) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth += 1;
      index += 2;
    } else if (sql[index] === '*' && sql[index + 1] === '/') {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else {
      index += 1;
    }
  }
  throw invalid('SQL has an unterminated block comment.');
}

/** Converts `?` placeholders to `$1…$n`. Returns { text, count }. */
export function convertPlaceholders(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') throw invalid('SQL text is required.');
  let output = '';
  let count = 0;
  let index = 0;
  let copied = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "'") {
      const escapeString = index > 0 && /[eE]/.test(sql[index - 1]) && !(index > 1 && identifierPart.test(sql[index - 2]));
      index = skipQuoted(sql, index, "'", { backslashEscapes: escapeString });
    } else if (char === '"') {
      index = skipQuoted(sql, index, '"');
    } else if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
    } else if (char === '/' && next === '*') {
      index = skipBlockComment(sql, index);
    } else if (char === '$') {
      const tag = dollarTagAt(sql, index);
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) throw invalid('SQL has an unterminated dollar-quoted string.');
        index = end + tag.length;
      } else if (/[0-9]/.test(next ?? '') && !(index > 0 && identifierPart.test(sql[index - 1]))) {
        throw invalid('SQL must use ? placeholders, not $n.');
      } else {
        index += 1;
      }
    } else if (char === '?') {
      count += 1;
      output += `${sql.slice(copied, index)}$${count}`;
      index += 1;
      copied = index;
    } else {
      index += 1;
    }
  }
  return { text: output + sql.slice(copied), count };
}

const cache = new Map();
const CACHE_LIMIT = 1_000;

/** Cached convertPlaceholders: repositories issue the same statements repeatedly. */
export function convertPlaceholdersCached(sql) {
  let converted = cache.get(sql);
  if (!converted) {
    converted = Object.freeze(convertPlaceholders(sql));
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(sql, converted);
  }
  return converted;
}
