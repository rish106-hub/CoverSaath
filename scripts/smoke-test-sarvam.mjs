#!/usr/bin/env node
/**
 * Smoke test for Sarvam API connectivity
 * Usage: node scripts/smoke-test-sarvam.mjs
 */

import assert from 'node:assert/strict';

const API_KEY = process.env.SARVAM_API_KEY;
const API_BASE = 'https://api.sarvam.ai';

function requiredApiKey(value) {
  assert.ok(typeof value === 'string' && value.trim().length > 0, 'SARVAM_API_KEY is required. Load it with Node --env-file or export it in the shell.');
  return value;
}

async function smokeTest() {
  console.log('🔬 Sarvam API Smoke Test');
  console.log('========================\n');

  const apiKey = requiredApiKey(API_KEY);
  console.log('✅ API request configured');
  console.log('📍 API Base:', API_BASE);
  console.log();

  try {
    // Test 1: Simple endpoint check - try to get account info or a simple endpoint
    // Sarvam doesn't have a public "health" endpoint, so we'll try a minimal request
    console.log('📡 Testing API connectivity...');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${API_BASE}/doc-ai/v1/job/digitise`, {
      method: 'POST',
      headers: {
        'api-subscription-key': apiKey,
      },
      body: new FormData(),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // We expect this to fail (no file provided), but we should get a 400/422, not a 401/403
    if (response.status === 401 || response.status === 403) {
      console.error('❌ Authentication failed (401/403)');
      console.error('   The API key is missing, invalid, or expired');
      process.exit(1);
    }

    if (response.status === 429) {
      console.error('❌ Rate limited (429)');
      console.error('   Too many requests, try again later');
      process.exit(1);
    }

    if (response.status >= 500) {
      console.error('❌ Server error (', response.status, ')');
      console.error('   Sarvam API may be experiencing issues');
      process.exit(1);
    }

    // 400/422 is expected (no file provided) - this means the key is valid
    if (response.status === 400 || response.status === 422) {
      console.log('✅ API connectivity confirmed!');
      console.log('   Status:', response.status, '(expected - no file provided)');
      console.log('   The API key is valid and the endpoint is reachable');
      process.exit(0);
    }

    console.log('⚠️  Unexpected status:', response.status);
    const text = await response.text();
    console.log('   Response:', text.slice(0, 200));
    process.exit(1);

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('❌ Request timeout (10s)');
      console.error('   The API did not respond in time');
    } else {
      console.error('❌ Network error:', error.message);
    }
    process.exit(1);
  }
}

smokeTest().catch(error => {
  console.error('❌ Smoke test setup failed:', error.message);
  process.exitCode = 1;
});
