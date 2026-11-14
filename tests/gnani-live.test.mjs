import test from 'node:test';
import assert from 'node:assert/strict';
import { createGnaniVoiceProvider } from '../src/integrations/index.js';

// Opt-in only (RUN_GNANI_LIVE=1). Real calls cost money and the wire format is from docs.gnani.ai and not exercised live: needs owner approval.
// Synthetic text only; no real person's speech.
const liveEnabled = process.env.RUN_GNANI_LIVE === '1';
const grant = { authorized: true, purpose: 'voice_intake', recipients: ['gnani'] };

test('opt-in live Gnani synthesises one short synthetic phrase', { skip: !liveEnabled && 'set RUN_GNANI_LIVE=1 to run' }, async () => {
  const provider = createGnaniVoiceProvider({ env: { ...process.env, GNANI_VOICE_ENABLED: 'true' } });
  const result = await provider.synthesize({ authorization: grant, text: 'Please upload your policy document.', lang: 'en-IN' });
  assert.ok(result.audio.byteLength > 0);
  assert.match(result.mime, /^audio\//);
});
