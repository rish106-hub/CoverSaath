#!/usr/bin/env node
/**
 * Smoke test for Sarvam API connectivity
 * Usage: node scripts/smoke-test-sarvam.mjs
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Try to get API key from environment, then fall back to reading .env file
let API_KEY = process.env.SARVAM_API_KEY;

if (!API_KEY) {
  try {
    const envPath = resolve('.env');
    const envContent = readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^SARVAM_API_KEY=(.+)$/m);
    if (match) {
      API_KEY = match[1].trim();
    }
  } catch (e) {
    // .env file doesn't exist or can't be read
  }
}
const API_BASE = 'https://api.sarvam.ai';

async function smokeTest() {
  console.log('🔬 Sarvam API Smoke Test');
  console.log('========================\n');

  if (!API_KEY) {
    console.error('❌ SARVAM_API_KEY not found in environment or .env file');
    console.log('   Please set SARVAM_API_KEY in your .env file');
    process.exit(1);
  }

  console.log('✅ API Key found');
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
        'api-subscription-key': API_KEY,
      },
      body: new FormData(),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // We expect this to fail (no file provided), but we should get a 400/422, not a 401/403
    if (response.status === 401 || response.status === 403) {
      console.error('❌ Authentication failed (401/403)');
      console.error('   The API key may be invalid or expired');
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

smokeTest();
