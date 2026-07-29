#!/usr/bin/env node

/**
 * Diagnostic test script for xAI Grok API
 * Run with: node test-api.mjs
 *
 * Make sure to set XAI_API_KEY environment variable first:
 * export XAI_API_KEY="your-api-key"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file manually
function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...valueParts] = trimmed.split('=');
          const value = valueParts.join('=').replace(/^["']|["']$/g, '');
          if (key && value && !process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    }
  } catch (e) {
    // Ignore errors loading .env
  }
}

loadEnv();

const API_KEY = process.env.XAI_API_KEY;
const BASE_URL = process.env.XAI_BASE_URL || 'https://api.x.ai/v1';
const MODEL = process.env.GROK_MODEL || 'grok-4.5';

console.log('='.repeat(60));
console.log('xAI Grok API Diagnostic Test');
console.log('='.repeat(60));
console.log('');

// Check API key
if (!API_KEY) {
  console.error('❌ ERROR: XAI_API_KEY environment variable is not set');
  console.log('');
  console.log('Please set your API key:');
  console.log('  export XAI_API_KEY="your-api-key-here"');
  console.log('');
  console.log('Or create a .env file with:');
  console.log('  XAI_API_KEY=your-api-key-here');
  process.exit(1);
}

console.log('Configuration:');
console.log(`  Base URL: ${BASE_URL}`);
console.log(`  Model: ${MODEL}`);
console.log(`  API Key: ${API_KEY.substring(0, 8)}...${API_KEY.substring(API_KEY.length - 4)}`);
console.log('');

// Test 1: List models
async function testListModels() {
  console.log('Test 1: Listing available models...');
  try {
    const response = await fetch(`${BASE_URL}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`  ❌ Failed with status ${response.status}: ${errorText}`);
      return false;
    }

    const data = await response.json();
    const models = data.data?.map(m => m.id) || [];
    console.log(`  ✅ Found ${models.length} models`);
    console.log(`  Available models: ${models.slice(0, 10).join(', ')}${models.length > 10 ? '...' : ''}`);
    return true;
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    return false;
  }
}

// Test 2: Simple chat completion
async function testChatCompletion() {
  console.log('');
  console.log('Test 2: Simple chat completion...');

  const payload = {
    model: MODEL,
    messages: [
      { role: 'user', content: 'Say hello in exactly 5 words.' }
    ],
    max_tokens: 50,
    temperature: 0.7,
  };

  console.log(`  Request payload: ${JSON.stringify(payload, null, 2).split('\n').join('\n  ')}`);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.log(`  ❌ Failed with status ${response.status}`);
      console.log(`  Response: ${responseText}`);

      // Try to parse error details
      try {
        const errorData = JSON.parse(responseText);
        if (errorData.error) {
          console.log(`  Error details: ${JSON.stringify(errorData.error, null, 2)}`);
        }
      } catch (e) {
        // Not JSON
      }
      return false;
    }

    const data = JSON.parse(responseText);
    const content = data.choices?.[0]?.message?.content;
    console.log(`  ✅ Success!`);
    console.log(`  Response: "${content}"`);
    console.log(`  Tokens used: ${data.usage?.total_tokens || 'N/A'}`);
    return true;
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    return false;
  }
}

// Test 3: Chat completion with search_parameters
async function testChatWithSearch() {
  console.log('');
  console.log('Test 3: Chat completion with live search...');

  const payload = {
    model: MODEL,
    messages: [
      { role: 'user', content: 'What is the current weather like? Just give a brief response.' }
    ],
    search_parameters: {
      mode: 'on',
      return_citations: true,
    },
    max_tokens: 200,
    temperature: 0.3,
  };

  console.log(`  Request payload: ${JSON.stringify(payload, null, 2).split('\n').join('\n  ')}`);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.log(`  ❌ Failed with status ${response.status}`);
      console.log(`  Response: ${responseText}`);

      // Try to parse error details
      try {
        const errorData = JSON.parse(responseText);
        if (errorData.error) {
          console.log(`  Error details: ${JSON.stringify(errorData.error, null, 2)}`);
        }
      } catch (e) {
        // Not JSON
      }
      return false;
    }

    const data = JSON.parse(responseText);
    const content = data.choices?.[0]?.message?.content;
    const citations = data.citations;
    console.log(`  ✅ Success!`);
    console.log(`  Response: "${content?.substring(0, 200)}${content?.length > 200 ? '...' : ''}"`);
    if (citations && citations.length > 0) {
      console.log(`  Citations: ${citations.length} sources found`);
    }
    return true;
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    return false;
  }
}

// Test 4: Minimal request (to identify required vs optional params)
async function testMinimalRequest() {
  console.log('');
  console.log('Test 4: Minimal request (only required params)...');

  const payload = {
    model: MODEL,
    messages: [
      { role: 'user', content: 'Hi' }
    ],
  };

  console.log(`  Request payload: ${JSON.stringify(payload)}`);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.log(`  ❌ Failed with status ${response.status}`);
      console.log(`  Response: ${responseText}`);
      return false;
    }

    const data = JSON.parse(responseText);
    console.log(`  ✅ Success!`);
    console.log(`  Response: "${data.choices?.[0]?.message?.content?.substring(0, 100)}..."`);
    return true;
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    return false;
  }
}

// Test 5: Try alternative models if main model fails
async function testAlternativeModels() {
  console.log('');
  console.log('Test 5: Testing alternative models...');

  const modelsToTest = [
    'grok-4.5',
    'grok-4.5-latest',
    'grok-4.3',
    'grok-latest',
    'grok-4.20',
    'grok-build-0.1',
  ];

  for (const model of modelsToTest) {
    console.log(`  Testing ${model}...`);

    const payload = {
      model: model,
      messages: [
        { role: 'user', content: 'Say OK' }
      ],
      max_tokens: 10,
    };

    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`    ✅ ${model} works! Response: "${data.choices?.[0]?.message?.content}"`);
      } else {
        const errorText = await response.text();
        console.log(`    ❌ ${model} failed: ${response.status} - ${errorText.substring(0, 100)}`);
      }
    } catch (error) {
      console.log(`    ❌ ${model} error: ${error.message}`);
    }
  }
}

// Run all tests
async function runTests() {
  const results = [];

  results.push(await testListModels());
  results.push(await testMinimalRequest());
  results.push(await testChatCompletion());
  results.push(await testChatWithSearch());
  await testAlternativeModels();

  console.log('');
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));

  const passed = results.filter(r => r).length;
  const failed = results.filter(r => !r).length;

  console.log(`  Passed: ${passed}/${results.length}`);
  console.log(`  Failed: ${failed}/${results.length}`);

  if (failed > 0) {
    console.log('');
    console.log('Troubleshooting tips:');
    console.log('  1. Verify your API key is correct and has sufficient credits');
    console.log('  2. Check if your API key has access to the model you\'re using');
  console.log('  3. Try a different model (e.g., grok-4.5 or grok-build-0.1)');
    console.log('  4. Check xAI API status at: https://status.x.ai');
    console.log('  5. Review the error messages above for specific issues');
  }

  console.log('');
}

runTests().catch(console.error);
