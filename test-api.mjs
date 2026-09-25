#!/usr/bin/env node
/** Live MCP smoke test. Build first; uses existing local credentials, never prints them.
 * node test-api.mjs [--url http://127.0.0.1:3002/mcp] [--quick]
 * Full mode calls paid xAI chat, web search, image search, and X search endpoints.
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const quick = args.includes('--quick');
const expectedModel = process.env.EXPECTED_GROK_MODEL || 'grok-4.7';
const expectedSearchModel = process.env.EXPECTED_GROK_SEARCH_MODEL || expectedModel;
const transport = urlIndex >= 0
  ? new StreamableHTTPClientTransport(new URL(args[urlIndex + 1]))
  : new StdioClientTransport({
      command: join(root, 'start-grok-mcp.sh'),
      cwd: root,
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      stderr: 'pipe',
    });
// Drain stderr without printing credentials or provider payloads on failures.
if (transport.stderr) transport.stderr.on('data', () => {});
const client = new Client({ name: 'grok-live-smoke', version: '2.3.0' });
const results = [];
async function check(name, run) {
  const started = Date.now();
  try {
    await run();
    results.push({ name, status: 'passed', duration_ms: Date.now() - started });
  } catch (error) {
    results.push({ name, status: 'failed', duration_ms: Date.now() - started });
    process.exitCode = 1;
    // Assertions describe the failed condition without dumping raw tool output.
    console.error(`${name}: ${error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : 'MCP request failed'}`);
  }
  console.log(JSON.stringify(results.at(-1)));
}
async function call(name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 100000 });
  assert(!result.isError, `${name} returned an MCP tool error`);
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert(text.trim(), `${name} returned empty content`);
  return text;
}
function assertSearch(text, domain) {
  assert(text.includes('Status: OK'), 'Live search did not succeed');
  assert(!text.includes('DEGRADED'), 'Search returned degraded fallback');
  assert(domain.test(text), 'Search did not return expected source citations');
}
try {
  await client.connect(transport);
  await check('tool discovery', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7, 'Expected seven MCP tools');
    assert(tools.find(tool => tool.name === 'grok_ask')?.description.includes(expectedModel), 'Tool schema uses an older model');
    console.log(JSON.stringify({ server: client.getServerVersion(), tools: tools.map(tool => tool.name) }));
  });
  await check('grok_health', async () => {
    const text = await call('grok_health');
    const runtime = JSON.parse(text.split('\n')[1]);
    assert.equal(runtime.model, expectedModel, 'Chat model differs from expected');
    assert.equal(runtime.search_model, expectedSearchModel, 'Search model differs from expected');
    console.log(JSON.stringify({ runtime }));
  });
  await check('grok_models', async () => {
    assert((await call('grok_models')).includes(`- ${expectedModel}`), 'Model catalog missing expected model');
  });
  await check('grok_test_connection', async () => {
    assert((await call('grok_test_connection')).includes('connection successful'), 'Live connection probe failed');
  });
  await check('grok_ask', async () => {
    const text = await call('grok_ask', { question: 'What is 17 + 25? Reply with only the number.', reasoning_effort: 'low', max_tokens: 512 });
    assert(/\b42\b/.test(text), 'Ask did not return the expected arithmetic answer');
  });
  await check('grok_chat', async () => {
    const text = await call('grok_chat', {
      messages: [{ role: 'user', content: 'My favorite color is blue.' },
        { role: 'assistant', content: 'Your favorite color is blue.' },
        { role: 'user', content: 'What is my favorite color? Reply with only the color.' }],
      reasoning_effort: 'low', max_tokens: 512,
    });
    assert(/\bblue\b/i.test(text), 'Chat lost conversation context');
  });
  if (!quick) {
    await check('grok_search', async () => {
      assertSearch(await call('grok_search', { query: 'Find the official xAI Grok 4.7 announcement and cite the source.', max_results: 3 }), /https:\/\/(?:docs\.)?x\.ai\//);
    });
    await check('grok_x_search', async () => {
      assertSearch(await call('grok_x_search', { query: 'Find a post from @xai announcing Grok 4.7. Cite the post URL.', max_results: 2 }), /https:\/\/(?:x|twitter)\.com\//);
    });
    await check('image search option', async () => {
      assertSearch(await call('grok_search', { query: 'Find a NASA photo of Saturn and cite its source.', enable_image_search: true, enable_image_understanding: true, max_results: 2 }), /https:\/\//);
    });
    await check('search-enabled chat', async () => {
      const text = await call('grok_chat', { messages: [{ role: 'user', content: 'Using current official xAI sources, name the latest public API flagship Grok model. Include a source URL.' }], include_search: true, reasoning_effort: 'low', max_tokens: 512 });
      assert(/4\.7/.test(text) && /https:\/\//.test(text), 'Search-enabled chat missing current model or citation');
    });
  }
  await check('invalid input errors', async () => {
    const result = await client.callTool({ name: 'grok_chat', arguments: { messages: [] } });
    assert.equal(result.isError, true, 'Invalid input was not marked as a tool error');
  });
} catch {
  console.error('MCP smoke test could not initialize. Check the launcher and credentials.');
  process.exitCode = 1;
} finally {
  await client.close();
  console.log(JSON.stringify({ passed: results.filter(result => result.status === 'passed').length, failed: results.filter(result => result.status === 'failed').length }));
}
