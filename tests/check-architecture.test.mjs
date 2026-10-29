import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-architecture.mjs', import.meta.url));

function check(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-architecture-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      const target = join(root, 'src', path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, text);
    }
    return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a tree without node:sqlite passes', () => {
  const result = check({ 'backend/ok.js': "import { createHash } from 'node:crypto';\nexport const x = createHash;\n" });
  assert.equal(result.status, 0, result.stderr);
});

for (const [label, text] of [
  ['static import', "import { DatabaseSync } from 'node:sqlite';\n"],
  ['dynamic import', "const { DatabaseSync } = await import('node:sqlite');\n"],
  ['require', "const { DatabaseSync } = require('node:sqlite');\n"],
  ['bare specifier', "import { DatabaseSync } from 'sqlite';\n"],
]) {
  test(`node:sqlite under src/ fails the architecture check (${label})`, () => {
    const result = check({ 'backend/database/legacy.js': text });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/backend\/database\/legacy\.js: node:sqlite is not allowed under src\//);
  });
}
