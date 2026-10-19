// File-backed test databases must live under the same allowed root as the application.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function testTempRoot() {
  const root = resolve('.local', 'test-tmp');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
