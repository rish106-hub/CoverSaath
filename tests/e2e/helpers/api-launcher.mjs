// Starts the real Knowvia API (createApiServer) on E2E_API_PORT with live-mode providers pointed at local fakes.
// Run with: node --import ./tests/e2e/helpers/egress-guard.mjs tests/e2e/helpers/api-launcher.mjs
// Only the Sarvam client's pacing is tuned (fast polling, no 10 req/min sleep) so tests are quick; the client,
// chunking, ZIP reader and pipeline are the production code.
import { createApiServer } from '../../../src/server/server.js';
import { createSarvamDocAiClient, createRequestLimiter } from '../../../src/integrations/sarvam/doc-ai-client.js';
import { chunkPdf } from '../../../src/modules/policy-breakdown/ocr/pdf-tools.js';
import { readZip } from '../../../src/modules/policy-breakdown/ocr/zip-reader.js';

const port = Number(process.env.E2E_API_PORT ?? 8787);
let ocr = null;
const server = createApiServer({
  env: process.env,
  policyBreakdownOverrides: {
    pageTextProvider(mode) {
      if (mode !== 'live') throw Object.assign(new Error('Fixture mode is disabled in the E2E server.'), { code: 'FIXTURE_MODE_UNAVAILABLE', statusCode: 503 });
      ocr ||= createSarvamDocAiClient({
        apiKey: process.env.SARVAM_API_KEY,
        language: process.env.SARVAM_DOCUMENT_LANGUAGE || 'en-IN',
        splitPdf: chunkPdf,
        readZip,
        limiter: createRequestLimiter({ perMinute: 100_000 }),
        pollIntervalMs: Number(process.env.E2E_SARVAM_POLL_MS ?? 20),
        requestTimeoutMs: Number(process.env.E2E_SARVAM_REQUEST_TIMEOUT_MS ?? 60_000),
        downloadHostSuffixes: ['sarvam-fake.test'],
      });
      return ocr;
    },
  },
});
server.listen(port, '127.0.0.1', () => console.log(`E2E_API_READY ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
