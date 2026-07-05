import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiServer } from '../src/api.js';
import { reloadConfig } from '../src/config.js';
import {
  appendEmailEvent,
  closeStoreForTests,
  configureDatabaseForTests,
  upsertEmailItemFromResult,
} from '../src/store.js';

let tempDir;
let server;
let baseUrl;

async function startServer() {
  server = createApiServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://${address.address}:${address.port}`;
}

beforeEach(async () => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  process.env.WINNOW_API_TOKEN = 'test-token';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-api-'));
  process.env.WINNOW_STATE_PATH = join(tempDir, 'state.json');
  process.env.WINNOW_CONFIG_PATH = join(tempDir, 'config.yaml');
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_APP_TOKEN = 'xapp-test';
  writeFileSync(process.env.WINNOW_CONFIG_PATH, `
accounts:
  - email: me@example.com
    channel: CTEST
slack:
  channel_id: CFALLBACK
api:
  host: 127.0.0.1
  port: 3777
`, 'utf8');
  reloadConfig();
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
  const item = upsertEmailItemFromResult({
    account: 'me@example.com',
    messageId: 'm1',
    threadId: 't1',
    from: 'Sender <sender@example.com>',
    subject: 'Hello',
    summary: 'A useful email',
    archive: false,
    confidence: 88,
  }, {
    account: 'me@example.com',
    messageId: 'm1',
    threadId: 't1',
    timestamp: '2026-06-29T16:00:00.000Z',
  });
  appendEmailEvent('email.scanned', item, { source: 'test', timestamp: '2026-06-29T16:00:00.000Z' });
  appendEmailEvent('email.kept', item, { source: 'test', timestamp: '2026-06-29T16:00:00.000Z' });
  await startServer();
});

afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
  delete process.env.WINNOW_API_TOKEN;
  delete process.env.WINNOW_STATE_PATH;
  delete process.env.WINNOW_CONFIG_PATH;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  reloadConfig();
});

describe('local API', () => {
  it('allows health without auth and protects v1 routes', async () => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const denied = await fetch(`${baseUrl}/v1/emails`);
    assert.equal(denied.status, 401);
  });

  it('lists emails and daily summaries with bearer auth', async () => {
    const headers = { Authorization: 'Bearer test-token' };
    const emails = await fetch(`${baseUrl}/v1/emails`, { headers });
    assert.equal(emails.status, 200);
    const emailJson = await emails.json();
    assert.equal(emailJson.items.length, 1);
    assert.equal(emailJson.items[0].subject, 'Hello');

    const summary = await fetch(`${baseUrl}/v1/summaries/daily?date=2026-06-29`, { headers });
    assert.equal(summary.status, 200);
    const summaryJson = await summary.json();
    assert.equal(summaryJson.counters.processed, 1);
    assert.equal(summaryJson.counters.kept, 1);
  });

  it('returns status and account routing metadata without secrets', async () => {
    const headers = { Authorization: 'Bearer test-token' };

    const accounts = await fetch(`${baseUrl}/v1/accounts`, { headers });
    assert.equal(accounts.status, 200);
    const accountsJson = await accounts.json();
    assert.equal(accountsJson.accounts.length, 1);
    assert.equal(accountsJson.accounts[0].email, 'me@example.com');
    assert.equal(accountsJson.accounts[0].slack.channelId, 'CTEST');
    assert.equal(accountsJson.accounts[0].slack.hasBotToken, true);
    assert.equal(accountsJson.accounts[0].slack.hasAppToken, true);
    assert.equal(accountsJson.accounts[0].slack.botToken, undefined);

    const status = await fetch(`${baseUrl}/v1/status`, { headers });
    assert.equal(status.status, 200);
    const statusJson = await status.json();
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.accounts[0].email, 'me@example.com');
    assert.equal(statusJson.slack.actionRouteCount, 1);
  });

  it('serves MCP initialize, tool list, and status tool calls', async () => {
    const headers = {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    };

    const initialize = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(initialize.status, 200);
    const initializeJson = await initialize.json();
    assert.equal(initializeJson.result.serverInfo.name, 'winnow');
    assert.equal(typeof initializeJson.result.capabilities.tools, 'object');

    const tools = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const toolsJson = await tools.json();
    assert.ok(toolsJson.result.tools.some(tool => tool.name === 'winnow_status'));
    assert.ok(toolsJson.result.tools.some(tool => tool.name === 'winnow_scan'));

    const status = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'winnow_status', arguments: {} },
      }),
    });
    const statusJson = await status.json();
    assert.equal(statusJson.result.structuredContent.ok, true);
    assert.equal(statusJson.result.structuredContent.accounts[0].email, 'me@example.com');
  });

  it('returns a client error for invalid JSON bodies', async () => {
    const res = await fetch(`${baseUrl}/v1/push/devices`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: '{not-json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_json');
  });
});
