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

// ADR 0017 D7: the model boundary rules.
const GATEWAY_OWNERS = ['features/ai-analysis/structuring-runtime.js', 'features/ai-analysis/live-coverage-runtime.js'];

test('the model boundary rules pass for the allowed owners', () => {
  const result = check({
    'features/ai-analysis/model-gateway.js': "export function createModelGateway() {}\nimport { isSealedModelInput } from './privacy-evidence-gate.js';\nexport const x = isSealedModelInput;\n",
    'features/ai-analysis/privacy-evidence-gate.js': "const GATED_TEXT = new WeakSet();\nexport function isSealedModelInput() { return GATED_TEXT; }\n",
    'features/ai-analysis/ai-sdk-runner.js': "import { ToolLoopAgent } from 'ai';\nexport function createAiSdkRunner() {}\n",
    'features/ai-analysis/index.js': "export { createModelGateway } from './model-gateway.js';\n",
    [GATEWAY_OWNERS[0]]: "import { createModelGateway } from './model-gateway.js';\nconst a = createModelGateway({});\nconst b = createAiSdkRunner({});\n",
    [GATEWAY_OWNERS[1]]: "import { createModelGateway } from './model-gateway.js';\nconst a = createModelGateway({});\n",
  });
  assert.equal(result.status, 0, result.stderr);
});

for (const [label, files, message] of [
  ['createModelGateway( outside the two runtimes', { 'server/bypass.js': "import { createModelGateway } from '../features/ai-analysis/model-gateway.js';\nexport const gateway = createModelGateway({ mode: 'live' });\n" }, /src\/server\/bypass\.js: only structuring-runtime\.js and live-coverage-runtime\.js may call createModelGateway\(/],
  ['createAiSdkRunner( outside the two runtimes', { 'features/ai-analysis/other.js': "const runner = createAiSdkRunner({});\n" }, /src\/features\/ai-analysis\/other\.js: only structuring-runtime\.js and live-coverage-runtime\.js may call createAiSdkRunner\(/],
  ['@ai-sdk imported outside ai-analysis', { 'server/direct.js': "import { google } from '@ai-sdk/google';\nexport default google;\n" }, /src\/server\/direct\.js: provider SDK imports \(@ai-sdk\/\*, ai\) belong to src\/features\/ai-analysis\//],
  ['ai imported outside ai-analysis', { 'features/other/direct.js': "import { generateText } from 'ai';\nexport default generateText;\n" }, /src\/features\/other\/direct\.js: provider SDK imports/],
  ['dynamic ai import outside ai-analysis', { 'features/other/dynamic.js': "const sdk = await import('@ai-sdk/google');\n" }, /src\/features\/other\/dynamic\.js: provider SDK imports/],
  ['isSealedModelInput imported outside the gateway', { 'features/ai-analysis/other.js': "import { isSealedModelInput } from './privacy-evidence-gate.js';\nexport const x = isSealedModelInput;\n" }, /src\/features\/ai-analysis\/other\.js: isSealedModelInput may be used only by model-gateway\.js/],
  ['isSealedModelInput re-exported by the module index', { 'features/ai-analysis/index.js': "export { isSealedModelInput } from './privacy-evidence-gate.js';\n" }, /isSealedModelInput may be used only by model-gateway\.js/],
  ['GATED_TEXT exported (named export)', { 'features/ai-analysis/privacy-evidence-gate.js': "const GATED_TEXT = new WeakSet();\nexport { GATED_TEXT };\n" }, /privacy-evidence-gate\.js: the gate registries .* must not be exported/],
  ['SEALED exported (declaration)', { 'features/ai-analysis/privacy-evidence-gate.js': "export const SEALED = new WeakMap();\n" }, /the gate registries .* must not be exported/],
  ['SAFE_STRUCTURED exported (aliased)', { 'features/ai-analysis/privacy-evidence-gate.js': "const SAFE_STRUCTURED = new WeakSet();\nexport { SAFE_STRUCTURED as registry };\n" }, /the gate registries .* must not be exported/],
]) {
  test(`model boundary: ${label} fails the architecture check`, () => {
    const result = check(files);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
  });
}

// Review fix P1-2: a provider request is built only under src/integrations.
for (const [label, files, message] of [
  ['a direct fetch call', { 'features/ai-analysis/direct.js': "export const go = () => fetch('https://example.invalid/v1');\n" }, /src\/features\/ai-analysis\/direct\.js: only src\/integrations may make a network call/],
  ['a Gemini endpoint literal', { 'server/endpoint.js': "export const url = 'https://generativelanguage.googleapis.com/v1beta/models/x';\n" }, /src\/server\/endpoint\.js: only src\/integrations may make a network call/],
]) {
  test(`provider requests: ${label} outside src/integrations fails the architecture check`, () => {
    const result = check(files);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
  });
}

test('provider requests: src/integrations may fetch', () => {
  const result = check({ 'integrations/sarvam/client.js': "export const go = () => fetch('https://example.invalid/v1');\n" });
  assert.equal(result.status, 0, result.stderr);
});

// Review fix P2-1: the model-boundary rules cannot be dodged by an alias, a namespace import or a default export.
for (const [label, files, message] of [
  ['namespace call of createAiSdkRunner', { 'server/ns.js': "import * as ai from '../features/ai-analysis/index.js';\nexport const r = ai.createAiSdkRunner({});\n" }, /may call createAiSdkRunner\(/],
  ['aliased import of createModelGateway', { 'server/alias.js': "import { createModelGateway as make } from '../features/ai-analysis/model-gateway.js';\nexport const g = make({});\n" }, /may call createModelGateway\(/],
  ['re-export of createAiSdkRunner by the module index', { 'features/ai-analysis/index.js': "export { createAiSdkRunner } from './ai-sdk-runner.js';\n" }, /may call createAiSdkRunner\(/],
  ['default export of SEALED', { 'features/ai-analysis/privacy-evidence-gate.js': "const SEALED = new WeakMap();\nexport default SEALED;\n" }, /the gate registries .* must not be exported/],
  ['default export of an object holding GATED_TEXT', { 'features/ai-analysis/privacy-evidence-gate.js': "const GATED_TEXT = new WeakSet();\nexport default { GATED_TEXT };\n" }, /the gate registries .* must not be exported/],
  ['module.exports of a registry', { 'features/ai-analysis/privacy-evidence-gate.js': "const SAFE_STRUCTURED = new WeakSet();\nmodule.exports = { SAFE_STRUCTURED };\n" }, /the gate registries .* must not be exported/],
]) {
  test(`model boundary evasion: ${label} fails the architecture check`, () => {
    const result = check(files);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
  });
}
