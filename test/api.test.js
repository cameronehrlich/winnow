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
    readState: 'unread',
    unsubscribeLink: 'mailto:unsubscribe@example.com',
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
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.store.ok, true);
    assert.equal(healthJson.store.path, undefined);

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
    assert.equal(emailJson.items[0].readState, 'unread');
    assert.equal(emailJson.items[0].isRead, false);

    const summary = await fetch(`${baseUrl}/v1/summaries/daily?date=2026-06-29`, { headers });
    assert.equal(summary.status, 200);
    const summaryJson = await summary.json();
    assert.equal(summaryJson.counters.processed, 1);
    assert.equal(summaryJson.counters.kept, 1);

    const lifetime = await fetch(`${baseUrl}/v1/summaries/lifetime?recentLimit=5`, { headers });
    assert.equal(lifetime.status, 200);
    const lifetimeJson = await lifetime.json();
    assert.equal(lifetimeJson.scope, 'lifetime');
    assert.equal(lifetimeJson.counters.processed, 1);
    assert.ok(lifetimeJson.recentActivity.length > 0);
    assert.equal(lifetimeJson.recentActivity[0].emailItemId, emailJson.items[0].id);
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

  it('bootstraps the native client with stable defaults and capabilities', async () => {
    const headers = { Authorization: 'Bearer test-token' };
    const response = await fetch(`${baseUrl}/v1/bootstrap`, { headers });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.apiVersion, 1);
    assert.equal(body.defaultAccount, 'me@example.com');
    assert.equal(body.defaults.emailState, 'all');
    assert.equal(body.defaults.pageSize, 50);
    assert.deepEqual(body.capabilities.emailStates, ['all', 'inbox', 'archived']);
    assert.ok(body.capabilities.emailActions.includes('mark-read'));
    assert.equal(body.capabilities.push.deviceRegistration, true);
    assert.equal(body.capabilities.push.delivery, false);
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

  it('preserves JSON-RPC batch and invalid-request handling on MCP', async () => {
    const headers = {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    };
    const batch = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 10, method: 'ping' },
        { jsonrpc: '2.0', id: 11, method: 'tools/list' },
      ]),
    });
    assert.equal(batch.status, 200);
    const batchJson = await batch.json();
    assert.equal(batchJson.length, 2);
    assert.deepEqual(batchJson.map(response => response.id), [10, 11]);

    const primitive = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: 'null',
    });
    assert.equal(primitive.status, 200);
    assert.equal((await primitive.json()).error.code, -32600);
  });

  it('rejects unsafe MCP scan arguments instead of coercing them', async () => {
    const headers = {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    };

    const invalidBoolean = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'winnow_scan',
          arguments: { dryRun: false, postToFeed: 'false' },
        },
      }),
    });
    const invalidBooleanJson = await invalidBoolean.json();
    assert.equal(invalidBooleanJson.error.code, -32602);
    assert.match(invalidBooleanJson.error.message, /postToFeed must be a boolean/);

    const invalidAccount = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'winnow_scan',
          arguments: { account: 'other@example.com' },
        },
      }),
    });
    const invalidAccountJson = await invalidAccount.json();
    assert.equal(invalidAccountJson.error.code, -32602);
    assert.match(invalidAccountJson.error.message, /configured accounts/);
  });

  it('reports mailto unsubscribe as manual and deduplicates repeat taps', async () => {
    const headers = { Authorization: 'Bearer test-token' };
    const feed = await fetch(`${baseUrl}/v1/emails?limit=1`, { headers });
    const feedJson = await feed.json();
    const item = feedJson.items[0];
    assert.equal(item.unsubscribeState, 'available');

    const first = await fetch(`${baseUrl}/v1/emails/${encodeURIComponent(item.id)}/unsubscribe`, {
      method: 'POST',
      headers,
    });
    assert.equal(first.status, 200);
    const firstJson = await first.json();
    assert.equal(firstJson.ok, false);
    assert.equal(firstJson.outcome, 'attempted');
    assert.equal(firstJson.requiresManualAction, true);
    assert.equal(firstJson.item.unsubscribeState, 'attempted');

    const second = await fetch(`${baseUrl}/v1/emails/${encodeURIComponent(item.id)}/unsubscribe`, {
      method: 'POST',
      headers,
    });
    const secondJson = await second.json();
    assert.equal(secondJson.outcome, 'attempted');
    assert.equal(secondJson.deduplicated, true);

    const refreshed = await fetch(`${baseUrl}/v1/emails/${encodeURIComponent(item.id)}`, { headers });
    assert.equal((await refreshed.json()).item.unsubscribeState, 'attempted');
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

    const nonObject = await fetch(`${baseUrl}/v1/push/devices`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: 'null',
    });
    assert.equal(nonObject.status, 400);
    assert.equal((await nonObject.json()).error, 'invalid_json_body');
  });

  it('registers APNs devices with environment and installation lifecycle metadata', async () => {
    const response = await fetch(`${baseUrl}/v1/push/devices`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceToken: 'a'.repeat(64),
        platform: 'ios',
        installationId: '11111111-1111-1111-1111-111111111111',
        environment: 'development',
        bundleId: 'com.cameronehrlich.Winnow',
        appVersion: '1.0 (1)',
      }),
    });
    assert.equal(response.status, 200);
    const device = (await response.json()).device;
    assert.equal(device.environment, 'development');
    assert.equal(device.installationId, '11111111-1111-1111-1111-111111111111');
    assert.equal(device.deviceToken, undefined);
  });

  it('rejects invalid feed filters and non-boolean scan controls', async () => {
    const headers = { Authorization: 'Bearer test-token' };

    const state = await fetch(`${baseUrl}/v1/emails?state=trash`, { headers });
    assert.equal(state.status, 400);
    assert.equal((await state.json()).error, 'invalid_state');

    const limit = await fetch(`${baseUrl}/v1/emails?limit=500`, { headers });
    assert.equal(limit.status, 400);
    assert.equal((await limit.json()).error, 'invalid_limit');

    const scan = await fetch(`${baseUrl}/v1/scans`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: 'false' }),
    });
    assert.equal(scan.status, 400);
    assert.equal((await scan.json()).error, 'invalid_dryRun');
  });
});
