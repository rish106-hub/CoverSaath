// Vite for browser E2E: same app config, but proxying /api and /ingest to the E2E API port and on its own port so
// it never collides with `npm run dev`. It never reads the repo's .env files (envDir points at this folder, which
// has none), so a real PostHog key can never reach a test browser; a dummy key exercises the SDK against the
// fake PostHog behind the API's consent-gated /ingest proxy.
import { defineConfig, mergeConfig } from 'vite';
import base from '../../vite.config.js';

export const e2eApiPort = Number(process.env.E2E_API_PORT ?? 8887);
export const e2eWebPort = Number(process.env.E2E_WEB_PORT ?? 5273);

export default mergeConfig(base, defineConfig({
  root: new URL('../../', import.meta.url).pathname,
  envDir: new URL('./', import.meta.url).pathname,
  define: { 'import.meta.env.VITE_POSTHOG_KEY': JSON.stringify('phc_e2e_dummy_key') },
  server: {
    port: e2eWebPort,
    proxy: { '/api': `http://127.0.0.1:${e2eApiPort}`, '/ingest': `http://127.0.0.1:${e2eApiPort}` },
  },
}));
