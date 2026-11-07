import { scrubText } from './redact.js';

// Stack frames are the only part of an error that leaves the process (ADR 0016). A frame is kept only if the whole line is
// a V8 frame ("at fn (file:line:col)", "at file:line:col", "at async Class.method (...)"); a line of an error message that
// merely starts with "at" or sits on a line of its own is dropped. The file is reduced to a repo-relative path, so a home
// directory or a checkout path never appears, and a frame whose pieces change under scrubbing is dropped.

const FRAME = /^at (?:async )?(?:new )?(?:(?<fn>[\w$.<>]+(?: \[as [\w$]+\])?) )?\(?(?<file>[^()\n]+?):(?<line>\d{1,7}):(?<col>\d{1,7})\)?$/;
const REPO_ROOT = /(?:^|[/\\])((?:src|scripts|node_modules)[/\\].+)$/;

/** Repo-relative form of a file name: from src/, scripts/ or node_modules/ onward; node: built-ins as is; else the base name. */
export function relativePath(file) {
  if (typeof file !== 'string') return null;
  let path = file.replace(/^file:\/\//, '');
  try { path = decodeURIComponent(path); } catch { /* keep as is */ }
  path = path.replace(/\\/g, '/');
  if (/^node:[a-z_/]+$/.test(path)) return path;
  const match = REPO_ROOT.exec(path);
  const relative = match ? match[1] : path.split('/').filter(Boolean).pop();
  return relative && /^[\w$@./+-]{1,200}$/.test(relative) ? relative : null;
}

export function safeFrame(line) {
  const match = FRAME.exec(String(line).trim());
  if (!match) return null;
  const { fn, file, line: lineNumber, col } = match.groups;
  const relative = relativePath(file);
  if (!relative) return null;
  const rendered = fn ? `at ${fn} (${relative}:${lineNumber}:${col})` : `at ${relative}:${lineNumber}:${col}`;
  return scrubText(rendered) === rendered ? rendered : null;
}

export function safeStackFrames(stack, limit = 6) {
  if (typeof stack !== 'string') return [];
  return stack.split('\n').map(safeFrame).filter(Boolean).slice(0, limit);
}
