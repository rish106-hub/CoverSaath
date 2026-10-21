#!/usr/bin/env node
/**
 * Smoke test for Google Gemini API connectivity
 * Usage: node scripts/smoke-test-gemini.mjs
 */

import assert from 'node:assert/strict';

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const MODEL = process.env.LLM_MODEL || 'gemini-2.5-flash-exp';

function requiredApiKey(value) {
  assert.ok(typeof value === 'string' && value.trim().length > 0, 'GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY is required. Load it with Node --env-file or export it in the shell.');
  return value;
}

function validateModelName(model) {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  // Allow known-safe model identifier characters only.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) return null;
  // Explicitly block path/control patterns.
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return null;
  return trimmed;
}

async function smokeTest() {
  console.log('🔬 Google Gemini API Smoke Test');
  console.log('==============================\n');

  if (!validateModelName(MODEL)) {
    console.error('❌ Invalid LLM_MODEL format.');
    console.error('   Allowed characters: letters, numbers, ".", "_", "-" (max 128 chars)');
    process.exit(1);
  }

  const apiKey = requiredApiKey(API_KEY);
  console.log('✅ API request configured');
  console.log('🤖 Model:', MODEL);
  console.log('');

  try {
    console.log('📡 Testing API connectivity...');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    // Test with a simple generateContent request
    const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
    const safeModel = validateModelName(MODEL);
    if (!safeModel) {
      console.error('❌ Invalid LLM_MODEL value');
      console.error('   Allowed characters: letters, numbers, ".", "_", "-"');
      process.exit(1);
    }
    const requestUrl = new URL(`${API_BASE}/${safeModel}:generateContent`);
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey, // header, not the URL: query strings end up in logs
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: 'Hello, this is a smoke test. Please respond with "OK".'
          }]
        }]
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

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

    if (response.status === 400) {
      const error = await response.json();
      console.error('❌ Bad request (400)');
      console.error('   Details:', JSON.stringify(error).slice(0, 300));
      if (error.error?.message?.includes('API key')) {
        console.error('   Invalid API key or model name');
      }
      process.exit(1);
    }

    if (response.status >= 500) {
      console.error('❌ Server error (', response.status, ')');
      console.error('   Google API may be experiencing issues');
      process.exit(1);
    }

    if (response.ok) {
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response text';
      console.log('✅ API connectivity confirmed!');
      console.log('   Status:', response.status);
      console.log('   Response:', text.slice(0, 100));
      console.log('');
      console.log('   The API key is valid and the model is accessible');
      process.exit(0);
    }

    console.log('⚠️  Unexpected status:', response.status);
    const text = await response.text();
    console.log('   Response:', text.slice(0, 200));
    process.exit(1);

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('❌ Request timeout (15s)');
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
