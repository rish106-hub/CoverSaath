#!/usr/bin/env node
/**
 * Smoke test for Google Gemini API connectivity
 * Usage: node scripts/smoke-test-gemini.mjs
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Try to get API key from environment, then fall back to reading .env file
let API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
let MODEL = process.env.LLM_MODEL;

if (!API_KEY || !MODEL) {
  try {
    const envPath = resolve('.env');
    const envContent = readFileSync(envPath, 'utf-8');
    
    console.log('📄 Reading .env from:', envPath);
    console.log('📄 File size:', envContent.length, 'bytes');
    console.log('📄 Line count:', envContent.split('\n').length);
    
    // Parse line by line, skipping comments and empty lines
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') continue;
      
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        if (key === 'GEMINI_API_KEY' && !API_KEY) {
          API_KEY = value;
          console.log('✅ Found GEMINI_API_KEY');
        }
        if (key === 'LLM_MODEL' && !MODEL) {
          MODEL = value;
          console.log('✅ Found LLM_MODEL');
        }
      }
    }
    
    console.log('After parsing: API_KEY=', !!API_KEY, 'MODEL=', !!MODEL);
  } catch (e) {
    console.log('❌ Error reading .env:', e.message);
  }
}

function validateModelName(model) {
  // Allow typical Gemini model IDs (e.g. gemini-2.5-flash-exp)
  // and block path/query/control characters.
  const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
  return typeof model === 'string' && MODEL_PATTERN.test(model);
}

async function smokeTest() {
  console.log('🔬 Google Gemini API Smoke Test');
  console.log('==============================\n');

  if (!API_KEY) {
    console.error('❌ GEMINI_API_KEY not found in environment, .env, or .env.local file');
    console.log('   Please set GEMINI_API_KEY in your .env or .env.local file');
    console.log('');
    console.log('   Required settings:');
    console.log('   - GEMINI_API_KEY=your-api-key');
    console.log('   - LLM_MODEL=gemini-2.5-flash-exp (or other model)');
    console.log('   - LLM_INPUT_USD_PER_MILLION=0.075 (or current rate)');
    console.log('   - LLM_OUTPUT_USD_PER_MILLION=0.3 (or current rate)');
    process.exit(1);
  }

  if (!MODEL) {
    console.warn('⚠️  LLM_MODEL not set, using default: gemini-2.5-flash-exp');
    MODEL = 'gemini-2.5-flash-exp';
  }

  if (!validateModelName(MODEL)) {
    console.error('❌ Invalid LLM_MODEL format.');
    console.error('   Allowed characters: letters, numbers, ".", "_", "-" (max 128 chars)');
    process.exit(1);
  }

  console.log('✅ API Key found (masked):', API_KEY.slice(0, 8) + '...' + API_KEY.slice(-4));
  console.log('🤖 Model:', MODEL);
  console.log('');

  try {
    console.log('📡 Testing API connectivity...');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    // Test with a simple generateContent request
    const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
    const requestUrl = new URL(`${API_BASE}/${MODEL}:generateContent`);
    requestUrl.searchParams.set('key', API_KEY);
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
      console.error('   The API key may be invalid or expired');
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

smokeTest();
