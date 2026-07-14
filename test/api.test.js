import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiServer } from '../src/api.js';
import { reloadConfig } from '../src/config.js';
import { getPushCapabilities } from '../src/push.js';
import {
  appendEmailEvent,
  claimHandlingUndo,
  closeStoreForTests,
  configureDatabaseForTests,
  getEmailItem,
  listEvents,
  listUserRuleRecords,
  updateEmailItemState,
  upsertEmailItemFromResult,
} from '../src/store.js';
import { SemanticPreviewError } from '../src/semantic-rule-preview.js';

let tempDir;
let server;
let baseUrl;
let apiDependencies;

async function startServer() {
  server = createApiServer(apiDependencies);
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
    avatar_url: https://example.com/avatar.png
    gmail_app_account_id: 2
slack:
  channel_id: CFALLBACK
api:
  host: 127.0.0.1
  port: 3777
`, 'utf8');
  reloadConfig();
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
  apiDependencies = {
    semanticRuleEvaluator: async ({ messages }) => ({
      model: 'test-model',
      sampledAt: '2026-07-13T20:00:00.000Z',
      evaluations: messages.map(message => ({
        emailItemId: message.id, matches: true, confidence: 91, reason: 'Representative match',
      })),
    }),
    archiveEmail: async ({ emailItemId, reason }) => updateEmailItemState(emailItemId, {
      triageState: 'manual_archived', mailboxState: 'archived', readState: 'read', reason,
    }),
    moveEmailToInbox: async ({ emailItemId, reason }) => updateEmailItemState(emailItemId, {
      triageState: 'restored', mailboxState: 'inbox', reason,
    }),
    fetchEmailContent: async item => ({
      emailItemId: item.id,
      account: item.account,
      threadId: item.threadId,
      focusedMessageId: item.messageId,
      subject: item.subject,
      messages: [{
        id: item.messageId,
        from: item.from,
        to: 'Me <me@example.com>',
        cc: '',
        subject: item.subject,
        date: 'Sun, 29 Jun 2026 09:00:00 -0700',
        body: 'This is the complete message body.',
      }],
      truncated: false,
      fetchedAt: '2026-06-29T16:01:00.000Z',
    }),
    fetchEmailAttachments: async item => [{
      messageId: 'm0', attachmentId: 'pdf-1', filename: 'invoice.pdf',
      mimeType: 'application/pdf', sizeBytes: 9,
    }],
    fetchEmailAttachment: async (item, attachmentId) => {
      if (attachmentId !== 'pdf-1') {
        const error = new Error('attachment_not_found');
        error.code = 'attachment_not_found';
        throw error;
      }
      return {
        attachment: {
          messageId: 'm0', attachmentId, filename: 'invoice.pdf',
          mimeType: 'application/pdf', sizeBytes: 9,
        },
        data: Buffer.from('%PDF-test'),
      };
    },
  };
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
    attachments: [{
      messageId: 'm0', attachmentId: 'pdf-1', filename: 'invoice.pdf',
      mimeType: 'application/pdf', sizeBytes: 9,
    }],
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
    assert.equal(emailJson.items[0].trackedThreadMessageCount, 1);
    assert.deepEqual(emailJson.items[0].attachments, [{
      messageId: 'm0', attachmentId: 'pdf-1', filename: 'invoice.pdf',
      mimeType: 'application/pdf', sizeBytes: 9,
    }]);

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

  it('collapses a Gmail conversation to its newest list item', async () => {
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm2', threadId: 't1',
      from: 'Sender <sender@example.com>', subject: 'Re: Hello', summary: 'Newest reply',
      archive: false, readState: 'unread',
    }, { timestamp: '2026-06-29T17:00:00.000Z' });

    const response = await fetch(`${baseUrl}/v1/emails?state=inbox`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].messageId, 'm2');
    assert.equal(body.items[0].trackedThreadMessageCount, 2);
  });

  it('returns the authoritative unread badge after a notification action', async () => {
    const headers = { Authorization: 'Bearer test-token' };
    const emails = await fetch(`${baseUrl}/v1/emails?state=inbox`, { headers }).then(response => response.json());
    const response = await fetch(
      `${baseUrl}/v1/emails/${encodeURIComponent(emails.items[0].id)}/archive`,
      { method: 'POST', headers },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.badge, 0);
    assert.equal(body.item.mailboxState, 'archived');
  });

  it('fetches complete email content on demand without adding it to list responses', async () => {
    const headers = { Authorization: 'Bearer test-token' };
    const emails = await fetch(`${baseUrl}/v1/emails`, { headers }).then(response => response.json());
    assert.equal(emails.items[0].body, undefined);

    const encodedID = encodeURIComponent(emails.items[0].id);
    const response = await fetch(`${baseUrl}/v1/emails/${encodedID}/content`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.content.account, 'me@example.com');
    assert.equal(body.content.messages.length, 1);
    assert.equal(body.content.focusedMessageId, 'm1');
    assert.equal(body.content.messages[0].body, 'This is the complete message body.');

    const missing = await fetch(`${baseUrl}/v1/emails/missing/content`, { headers });
    assert.equal(missing.status, 404);
  });

  it('refreshes attachment metadata and serves a scoped supported attachment', async () => {
    const headers = { Authorization: 'Bearer test-token' };
    const list = await fetch(`${baseUrl}/v1/emails`, { headers }).then(response => response.json());
    const encodedID = encodeURIComponent(list.items[0].id);

    const metadataResponse = await fetch(`${baseUrl}/v1/emails/${encodedID}/attachments`, { headers });
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.deepEqual(metadata.attachments, [{
      messageId: 'm0', attachmentId: 'pdf-1', filename: 'invoice.pdf',
      mimeType: 'application/pdf', sizeBytes: 9,
    }]);
    assert.deepEqual(getEmailItem(list.items[0].id).attachments, metadata.attachments);

    const fileResponse = await fetch(`${baseUrl}/v1/emails/${encodedID}/attachments/pdf-1`, { headers });
    assert.equal(fileResponse.status, 200);
    assert.equal(fileResponse.headers.get('content-type'), 'application/pdf');
    assert.match(fileResponse.headers.get('content-disposition'), /invoice\.pdf/);
    assert.equal(Buffer.from(await fileResponse.arrayBuffer()).toString(), '%PDF-test');

    const missing = await fetch(`${baseUrl}/v1/emails/${encodedID}/attachments/not-in-thread`, { headers });
    assert.equal(missing.status, 404);
  });

  it('returns status and account routing metadata without secrets', async () => {
    const headers = { Authorization: 'Bearer test-token' };

    const accounts = await fetch(`${baseUrl}/v1/accounts`, { headers });
    assert.equal(accounts.status, 200);
    const accountsJson = await accounts.json();
    assert.equal(accountsJson.accounts.length, 1);
    assert.equal(accountsJson.accounts[0].email, 'me@example.com');
    assert.equal(accountsJson.accounts[0].avatarUrl, 'https://example.com/avatar.png');
    assert.equal(accountsJson.accounts[0].gmailAppAccountId, 2);
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
    assert.equal(body.capabilities.push.delivery, getPushCapabilities().delivery);
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

  it('manages structured user rules without exposing operator hook fields', async () => {
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const aggregate = await fetch(`${baseUrl}/v1/rules`, { headers });
    assert.equal(aggregate.status, 200);
    const aggregateJson = await aggregate.json();
    assert.ok(aggregateJson.rules.some(rule => rule.account === null && rule.scope === 'baseline'));
    assert.equal(new Set(aggregateJson.rules.map(rule => rule.id)).size, aggregateJson.rules.length);
    assert.equal(typeof aggregateJson.migrationPendingByAccount['me@example.com'], 'boolean');

    const baseline = await fetch(`${baseUrl}/v1/rules?account=me%40example.com`, { headers });
    assert.equal(baseline.status, 200);
    const baselineJson = await baseline.json();
    assert.ok(baselineJson.rules.some(rule => rule.scope === 'baseline' && rule.editable === false));
    assert.doesNotMatch(JSON.stringify(baselineJson), /"action"|"trigger"|"command"/);

    const preview = await fetch(`${baseUrl}/v1/rules/preview`, {
      method: 'POST', headers,
      body: JSON.stringify({
        candidate: {
          account: 'me@example.com', type: 'exact', effect: 'archive',
          matcherKind: 'sender', matcherValue: 'sender@example.com',
        },
      }),
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).matchCount, 1);

    const created = await fetch(`${baseUrl}/v1/rules`, {
      method: 'POST', headers,
      body: JSON.stringify({
        account: 'me@example.com', type: 'exact', effect: 'archive',
        matcherKind: 'sender', matcherValue: 'sender@example.com',
      }),
    });
    assert.equal(created.status, 201);
    const rule = (await created.json()).rule;
    assert.equal(rule.editable, true);

    const updated = await fetch(`${baseUrl}/v1/rules/${rule.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({
        effect: 'keep',
        expectedRule: { ruleId: rule.id, updatedAt: rule.updatedAt },
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).rule.effect, 'keep');

    const disabled = await fetch(`${baseUrl}/v1/rules/${rule.id}/disable`, { method: 'POST', headers });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).rule.enabled, false);

    const reset = await fetch(`${baseUrl}/v1/rules/${rule.id}/reset`, { method: 'POST', headers });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).reset, true);
  });

  it('exposes handling decisions and only undoes while scan state is still current', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm1', threadId: 't1',
      from: 'Sender <sender@example.com>', subject: 'Hello', summary: 'A useful email',
      archive: true, readState: 'read', confidence: 100,
      handlingDecision: {
        effect: 'archive', basis: 'exact_rule', explanation: 'Matched sender rule',
        confidence: 100, handledAt: '2026-07-13T20:00:00.000Z',
        appliedRule: {
          id: 'rule-sender', description: 'Sender rule', scope: 'user', source: 'assistant',
          editable: true, attribution: 'deterministic',
        },
      },
    });
    const headers = { Authorization: 'Bearer test-token' };
    const fetched = await fetch(`${baseUrl}/v1/emails/${encodeURIComponent(item.id)}`, { headers });
    const fetchedItem = (await fetched.json()).item;
    assert.equal(fetchedItem.handlingDecision.appliedRule.id, 'rule-sender');
    assert.equal(fetchedItem.undoAction, 'move-to-inbox');

    const undone = await fetch(`${baseUrl}/v1/emails/${encodeURIComponent(item.id)}/undo-handling`, {
      method: 'POST', headers,
    });
    assert.equal(undone.status, 200);
    const body = await undone.json();
    assert.equal(body.ok, true);
    assert.equal(body.action, 'undo-handling');
    assert.equal(body.item.mailboxState, 'inbox');
    assert.equal(body.item.undoAction, null);
    assert.match(body.item.reason, /future rule behavior is unchanged/i);

    const repeated = await fetch(`${baseUrl}/v1/emails/${encodeURIComponent(item.id)}/undo-handling`, {
      method: 'POST', headers,
    });
    assert.equal(repeated.status, 409);
    assert.equal((await repeated.json()).error, 'handling_not_undoable');
  });

  it('requires an exact preview binding before replacing a conflicting rule', async () => {
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const original = await fetch(`${baseUrl}/v1/rules`, {
      method: 'POST', headers,
      body: JSON.stringify({
        account: 'me@example.com', type: 'exact', effect: 'archive',
        matcherKind: 'domain', matcherValue: 'example.com', description: 'Original domain rule',
      }),
    });
    const originalRule = (await original.json()).rule;
    const candidate = {
      account: 'me@example.com', type: 'exact', effect: 'keep',
      matcherKind: 'domain', matcherValue: 'example.com', description: 'Replacement domain rule',
    };
    const unbound = await fetch(`${baseUrl}/v1/rules`, {
      method: 'POST', headers, body: JSON.stringify(candidate),
    });
    assert.equal(unbound.status, 409);
    assert.equal((await unbound.json()).error, 'rule_conflict_confirmation_required');

    const previewResponse = await fetch(`${baseUrl}/v1/rules/preview`, {
      method: 'POST', headers, body: JSON.stringify({ candidate }),
    });
    const preview = await previewResponse.json();
    assert.equal(preview.conflict.rule.id, originalRule.id);
    const replaced = await fetch(`${baseUrl}/v1/rules`, {
      method: 'POST', headers,
      body: JSON.stringify({
        ...candidate,
        expectedConflict: {
          ruleId: preview.conflict.rule.id,
          updatedAt: preview.conflict.rule.updatedAt,
        },
      }),
    });
    assert.equal(replaced.status, 201);
    assert.equal((await replaced.json()).rule.effect, 'keep');
  });

  it('revision-binds PATCH matcher changes and atomically merges a confirmed target', async () => {
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const create = async (matcherValue, effect) => {
      const response = await fetch(`${baseUrl}/v1/rules`, {
        method: 'POST', headers,
        body: JSON.stringify({
          account: 'me@example.com', type: 'exact', effect,
          matcherKind: 'sender', matcherValue,
        }),
      });
      return (await response.json()).rule;
    };
    const edited = await create('first@example.com', 'archive');
    const target = await create('second@example.com', 'keep');
    const candidate = {
      id: edited.id, account: edited.account, type: 'exact', effect: 'archive',
      matcherKind: 'sender', matcherValue: 'second@example.com', description: 'Merged rule', enabled: true,
    };
    const previewResponse = await fetch(`${baseUrl}/v1/rules/preview`, {
      method: 'POST', headers, body: JSON.stringify({ candidate }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.deepEqual(preview.expectedRule, { ruleId: edited.id, updatedAt: edited.updatedAt });
    assert.equal(preview.conflict.rule.id, target.id);

    const missingRevision = await fetch(`${baseUrl}/v1/rules/${edited.id}`, {
      method: 'PATCH', headers, body: JSON.stringify(candidate),
    });
    assert.equal(missingRevision.status, 409);
    assert.equal((await missingRevision.json()).error, 'rule_revision_confirmation_required');

    const updated = await fetch(`${baseUrl}/v1/rules/${edited.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({
        ...candidate,
        expectedRule: preview.expectedRule,
        expectedConflict: {
          ruleId: preview.conflict.rule.id,
          updatedAt: preview.conflict.rule.updatedAt,
        },
      }),
    });
    assert.equal(updated.status, 200);
    const saved = (await updated.json()).rule;
    assert.equal(saved.id, edited.id);
    assert.equal(saved.matcherValue, 'second@example.com');
    assert.equal(listUserRuleRecords({ account: 'me@example.com' }).some(rule => rule.id === target.id), false);

    const stale = await fetch(`${baseUrl}/v1/rules/${edited.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ description: 'Stale edit', expectedRule: preview.expectedRule }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'rule_revision_changed');
  });

  it('atomically rejects a concurrent undo while the first Gmail operation is in flight', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-concurrent-undo', threadId: 't-concurrent-undo',
      from: 'Sender <sender@example.com>', subject: 'Concurrent undo', archive: true,
      handlingDecision: {
        id: 'decision-concurrent-undo', effect: 'archive', basis: 'classifier',
        explanation: 'Archived by Winnow', confidence: 90, handledAt: new Date().toISOString(),
      },
    });
    let releaseOperation;
    let markStarted;
    const operationStarted = new Promise(resolve => { markStarted = resolve; });
    const operationGate = new Promise(resolve => { releaseOperation = resolve; });
    apiDependencies.moveEmailToInbox = async ({ emailItemId, reason }) => {
      markStarted();
      await operationGate;
      return updateEmailItemState(emailItemId, {
        triageState: 'restored', mailboxState: 'inbox', reason,
      });
    };
    const headers = { Authorization: 'Bearer test-token' };
    const url = `${baseUrl}/v1/emails/${encodeURIComponent(item.id)}/undo-handling`;
    const firstRequest = fetch(url, { method: 'POST', headers });
    await operationStarted;
    const concurrent = await fetch(url, { method: 'POST', headers });
    assert.equal(concurrent.status, 409);
    assert.equal((await concurrent.json()).error, 'handling_not_undoable');
    releaseOperation();
    const first = await firstRequest;
    assert.equal(first.status, 200);
    assert.equal((await first.json()).item.mailboxState, 'inbox');
  });

  it('reclaims a stale undo lease after a store restart', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-stale-undo', threadId: 't-stale-undo',
      from: 'Sender <sender@example.com>', subject: 'Stale undo', archive: true,
      handlingDecision: {
        id: 'decision-stale-undo', effect: 'archive', basis: 'classifier',
        explanation: 'Archived by Winnow', confidence: 90, handledAt: '2026-07-13T20:00:00.000Z',
      },
    });
    const claim = claimHandlingUndo(item.id, 'decision-stale-undo', 'crashed-process', {
      now: new Date('2020-01-01T00:00:00.000Z'),
    });
    assert.equal(claim.claimed, true);
    closeStoreForTests();
    configureDatabaseForTests(join(tempDir, 'winnow.db'));
    let executions = 0;
    apiDependencies.moveEmailToInbox = async ({ emailItemId, reason }) => {
      executions += 1;
      return updateEmailItemState(emailItemId, {
        triageState: 'restored', mailboxState: 'inbox', reason,
      });
    };
    const response = await fetch(`${baseUrl}/v1/emails/${encodeURIComponent(item.id)}/undo-handling`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 200);
    assert.equal(executions, 1);
    assert.equal(getEmailItem(item.id).handlingUndoStatus, 'completed');
  });

  it('completes a stale undo claim without repeating an already-applied mailbox action', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-crash-after-state', threadId: 't-crash-after-state',
      from: 'Sender <sender@example.com>', subject: 'Crash after state', archive: true,
      handlingDecision: {
        id: 'decision-crash-after-state', effect: 'archive', basis: 'classifier',
        explanation: 'Archived by Winnow', confidence: 90, handledAt: '2026-07-13T20:00:00.000Z',
      },
    });
    assert.equal(claimHandlingUndo(item.id, 'decision-crash-after-state', 'crashed-process', {
      now: new Date('2020-01-01T00:00:00.000Z'),
    }).claimed, true);
    updateEmailItemState(item.id, { triageState: 'restored', mailboxState: 'inbox' });
    closeStoreForTests();
    configureDatabaseForTests(join(tempDir, 'winnow.db'));
    let executions = 0;
    apiDependencies.moveEmailToInbox = async () => {
      executions += 1;
      throw new Error('must not repeat an already applied operation');
    };
    const response = await fetch(`${baseUrl}/v1/emails/${encodeURIComponent(item.id)}/undo-handling`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 200);
    assert.equal(executions, 0);
    assert.equal(getEmailItem(item.id).handlingUndoStatus, 'completed');
  });

  it('returns a stable retryable semantic-preview error without mutations', async () => {
    const rulesBefore = listUserRuleRecords().length;
    const eventsBefore = listEvents({ limit: 500 }).length;
    apiDependencies.semanticRuleEvaluator = async () => {
      throw new SemanticPreviewError();
    };
    const response = await fetch(`${baseUrl}/v1/rules/preview`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidate: {
          account: 'me@example.com', type: 'semantic', effect: 'archive', match: 'Routine receipts',
        },
      }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, 'semantic_preview_unavailable');
    assert.equal(body.retryable, true);
    assert.equal(listUserRuleRecords().length, rulesBefore);
    assert.equal(listEvents({ limit: 500 }).length, eventsBefore);
  });

  it('serves semantic sampled previews and forward-only rule activity', async () => {
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const semanticPreview = await fetch(`${baseUrl}/v1/rules/preview`, {
      method: 'POST', headers,
      body: JSON.stringify({
        candidate: {
          account: 'me@example.com', type: 'semantic', effect: 'archive', match: 'Routine messages',
        },
      }),
    });
    assert.equal(semanticPreview.status, 200);
    const preview = await semanticPreview.json();
    assert.equal(preview.mode, 'semantic');
    assert.equal(preview.model, 'test-model');
    assert.equal(preview.matches[0].emailItemId.length > 0, true);

    const created = await fetch(`${baseUrl}/v1/rules`, {
      method: 'POST', headers,
      body: JSON.stringify({
        account: 'me@example.com', type: 'exact', effect: 'archive',
        matcherKind: 'sender', matcherValue: 'sender@example.com',
      }),
    });
    const rule = (await created.json()).rule;
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm1', threadId: 't1',
      from: 'Sender <sender@example.com>', subject: 'Hello', archive: true,
      handlingDecision: {
        effect: 'archive', basis: 'exact_rule', explanation: 'Matched', confidence: 100,
        handledAt: new Date().toISOString(),
        appliedRule: {
          id: rule.id, description: 'Sender', scope: 'user', source: 'api', editable: true,
          attribution: 'deterministic', effect: 'archive', revision: rule.updatedAt,
        },
      },
    });
    const listed = await fetch(`${baseUrl}/v1/rules?account=me%40example.com`, { headers });
    const listedRule = (await listed.json()).rules.find(candidate => candidate.id === rule.id);
    assert.equal(listedRule.activity.appliedCount30Days, 1);
    assert.equal(listedRule.activity.recent[0].messageId, 'm1');

    const edited = await fetch(`${baseUrl}/v1/rules/${rule.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({
        effect: 'keep',
        expectedRule: { ruleId: rule.id, updatedAt: rule.updatedAt },
      }),
    });
    assert.equal(edited.status, 200);
    const relisted = await fetch(`${baseUrl}/v1/rules?account=me%40example.com`, { headers });
    const currentRevision = (await relisted.json()).rules.find(candidate => candidate.id === rule.id);
    assert.equal(currentRevision.activity.appliedCount30Days, 0);
    assert.equal(currentRevision.activity.recent.length, 0);
  });
});
