// Long-running stack for Playwright's webServer: fakes + real API on fixed ports. Stops on SIGTERM.
// Fixed fake ports let specs read what /ingest forwarded (fake PostHog GET /__events) and inject provider
// failures (fake Gemini / Sarvam POST /__control).
import { startStack } from './stack.mjs';

const stack = await startStack({
  apiPort: Number(process.env.E2E_API_PORT ?? 8887),
  posthogPort: Number(process.env.E2E_POSTHOG_PORT ?? 8889),
  geminiPort: Number(process.env.E2E_GEMINI_PORT ?? 8890),
  sarvamPort: Number(process.env.E2E_SARVAM_PORT ?? 8891),
  pack: process.env.E2E_PACK ?? 'a',
  staticDir: process.env.E2E_STATIC_DIR || null,
});
console.log(`E2E_STACK_READY api=${stack.base} sarvam=${stack.sarvam.origin} gemini=${stack.gemini.origin} posthog=${stack.posthog.origin}`);
const shutdown = () => stack.stop().finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
