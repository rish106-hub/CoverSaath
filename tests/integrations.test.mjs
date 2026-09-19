import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmailProvider,
  createGnaniVoiceProvider,
  createPineLabsPaymentProvider,
  createSarvamOcrProvider,
} from '../src/integrations/index.js';
import {
  capabilities,
  createAdapters,
  institutionalAdapter,
  ocrAdapter,
  paymentAdapter,
  voiceAdapter,
} from '../src/adapters/index.js';

test('capabilities report manual upload and no active HRMS connector', () => {
  const result = capabilities({});
  assert.equal(result.documentIntake.status, 'manual_upload_only');
  assert.equal(Object.hasOwn(result, 'hrms'), false);
  assert.equal(result.sarvamOcr.status, 'not_configured');
  assert.equal(result.gnani.status, 'not_configured');
  assert.equal(result.pineLabs.status, 'not_configured');
  assert.equal(result.email.status, 'not_configured');
});

test('providers stay unconfigured without every required setting', () => {
  assert.equal(createSarvamOcrProvider({ env: {} }).health().status, 'not_configured');
  assert.equal(createGnaniVoiceProvider({ env: {} }).health().status, 'not_configured');
  assert.equal(createPineLabsPaymentProvider({ env: { PINE_LABS_CLIENT_ID: 'id' } }).health().status, 'not_configured');
  assert.equal(createEmailProvider({ env: { EMAIL_API_KEY: 'key' } }).health().status, 'not_configured');
});

test('configured providers remain unverified and make no network claim', async () => {
  const providers = [
    [createSarvamOcrProvider({ env: { SARVAM_API_KEY: 'secret' } }), provider => provider.createJob({ authorization: true })],
    [createGnaniVoiceProvider({ env: { GNANI_API_KEY_ID: 'secret' } }), provider => provider.transcribe({ authorization: true })],
    [createPineLabsPaymentProvider({ env: { PINE_LABS_CLIENT_ID: 'id', PINE_LABS_CLIENT_SECRET: 'secret' } }), provider => provider.createHostedCheckout({ authorization: true })],
    [createEmailProvider({ env: { EMAIL_API_KEY: 'secret', EMAIL_FROM: 'sender@example.test' } }), provider => provider.sendApprovedMessage({ authorization: true })],
  ];
  for (const [provider, invoke] of providers) {
    assert.equal(provider.health().status, 'configured_not_verified');
    assert.equal(provider.health().networkAttempted, false);
    await assert.rejects(() => invoke(provider), error => error.code === 'PROVIDER_CONTRACT_NOT_VERIFIED' && /No external action/.test(error.message));
  }
});

test('configured providers also require explicit authorization', async () => {
  const provider = createSarvamOcrProvider({ env: { SARVAM_API_KEY: 'secret' } });
  await assert.rejects(() => provider.createJob(), error => error.code === 'PROVIDER_AUTHORIZATION_REQUIRED');
});

test('legacy adapters preserve their fail-closed API', async () => {
  await assert.rejects(() => voiceAdapter.transcribe(), /No external action/);
  await assert.rejects(() => paymentAdapter.createCheckout(), /No external action/);
  await assert.rejects(() => institutionalAdapter.send(), /No external action/);
  await assert.rejects(() => ocrAdapter.createJob(), /No external action/);
});

test('adapter factory uses injected configuration without module-level provider instances', async () => {
  const adapters = createAdapters({ env: { GNANI_API_KEY_ID: 'configured-for-test' } });
  await assert.rejects(
    () => adapters.voice.transcribe('synthetic audio', true),
    error => error.code === 'PROVIDER_CONTRACT_NOT_VERIFIED',
  );
  await assert.rejects(
    () => adapters.payment.createCheckout({}, true),
    error => error.code === 'PROVIDER_NOT_CONFIGURED',
  );
});
