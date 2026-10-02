import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes:true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : extname(entry.name) === '.js' ? [path] : [];
  }));
  return nested.flat();
}

test('live source contains no retired product or readiness-drill behavior', async () => {
  const files = await sourceFiles(sourceRoot);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /CoverSaath|Coversaath/i, file);
    assert.doesNotMatch(source, /five-minute|5-minute|readinessDrill|readiness drill/i, file);
  }
});
