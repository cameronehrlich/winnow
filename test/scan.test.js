import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scan } from '../src/scan.js';
import { normalizeMessageContent } from '../src/message-content.js';
import { claimProcessing, loadState } from '../src/state.js';
import { closeStoreForTests, configureDatabaseForTests, listEvents, listEmailItems } from '../src/store.js';

let tempDir;

function makeAdapter(messages = []) {
  return {
    ensureLabel: async () => {},
    fetchUnread: async () => messages,
    getMessage: async (_account, id) => {
      const msg = messages.find(entry => (entry.id || entry.threadId) === id || entry.threadId === id);
      return msg ? { ...msg, headers: msg.headers || {} } : null;
    },
    modifyLabels: async () => {},
  };
}

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-scan-'));
  process.env.WINNOW_STATE_PATH = join(tempDir, 'state.json');
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
});

afterEach(() => {
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
  delete process.env.WINNOW_STATE_PATH;
});

describe('scan execution controls', () => {
  it('applies the newest matching assistant archive rule without calling Gemini', async () => {
    const messages = [{
      id: 'm-assistant-archive',
      threadId: 't-assistant-archive',
      subject: 'Weekly product update',
      from: 'Updates <updates@example.com>',
      snippet: 'This week in product news',
      headers: {},
    }];
    let classifyCalls = 0;

    const results = await scan('me@example.com', {
      adapter: makeAdapter(messages),
      config: { scan: { max_messages: 10 } },
      dryRun: true,
      listAssistantRulesFn: ({ account, enabledOnly }) => {
        assert.equal(account, 'me@example.com');
        assert.equal(enabledOnly, true);
        return [{
          id: 'rule-archive', account, effect: 'archive', matcherKind: 'sender',
          matcherValue: 'updates@example.com', enabled: true,
        }];
      },
      classifyEmailFn: async () => {
        classifyCalls++;
        return { archive: false, confidence: 90, summary: 'model result' };
      },
    });

    assert.equal(classifyCalls, 0);
    assert.equal(results[0].archive, true);
    assert.equal(results[0].confidence, 100);
    assert.equal(results[0].ephemeral, false);
    assert.equal(results[0].handling, 'archive');
    assert.match(results[0].reason, /rule-archive/);
  });

  it('lets the newest matching keep rule override an older archive rule and bypass Gemini', async () => {
    const messages = [{
      id: 'm-assistant-keep',
      threadId: 't-assistant-keep',
      subject: 'Important sender',
      from: 'search-result@example.net',
      snippet: 'Please review',
      headers: {},
    }];
    const adapter = makeAdapter(messages);
    adapter.getMessage = async () => ({
      ...messages[0],
      payload: {
        headers: [
          { name: 'From', value: 'Important <person@example.com>' },
          { name: 'List-ID', value: '<important.example.com>' },
        ],
      },
    });
    let classifyCalls = 0;

    const results = await scan('me@example.com', {
      adapter,
      config: { scan: { max_messages: 10 } },
      dryRun: true,
      // Unified rule storage returns highest-precedence (newest) rules first.
      listAssistantRulesFn: () => [
        {
          id: 'rule-new-keep', account: 'me@example.com', effect: 'keep',
          matcherKind: 'list_id', matcherValue: 'important.example.com', enabled: true,
        },
        {
          id: 'rule-old-archive', account: 'me@example.com', effect: 'archive',
          matcherKind: 'sender', matcherValue: 'person@example.com', enabled: true,
        },
      ],
      classifyEmailFn: async () => {
        classifyCalls++;
        return { archive: true, confidence: 99, summary: 'model result' };
      },
    });

    assert.equal(classifyCalls, 0);
    assert.equal(results[0].archive, false);
    assert.equal(results[0].confidence, 100);
    assert.equal(results[0].handling, 'keep');
    assert.equal(results[0].action, 'Review email in inbox');
    assert.match(results[0].reason, /rule-new-keep/);
  });

  it('passes the latest authored reply to classification instead of quoted history', async () => {
    const messages = [{
      id: 'm-reply',
      threadId: 't-reply',
      subject: 'Re: Account renewal',
      from: 'Customer <customer@example.com>',
      snippet: 'Please cancel the renewal.',
      body: `Please cancel the renewal.

On Mon, Jul 13, 2026 at 8:14 AM Account Team <accounts@example.com> wrote:
> Your account will renew for $1,200 on August 1.`,
      headers: {},
    }];

    let classifiedMessage;
    await scan('me@example.com', {
      adapter: makeAdapter(messages),
      config: { scan: { max_messages: 10 } },
      dryRun: true,
      classifyEmailFn: async message => {
        classifiedMessage = message;
        return { archive: false, confidence: 95, summary: 'Customer asked to cancel the renewal.' };
      },
    });

    // The scan retains the full fetched body for deterministic hooks; the
    // classifier's own normalization layer is responsible for separating it.
    const { latestContent, threadContext } = normalizeMessageContent(classifiedMessage.body);
    assert.equal(latestContent, 'Please cancel the renewal.');
    assert.match(threadContext, /renew for \$1,200/);
  });

  it('skips messages already claimed by another scan', async () => {
    const messages = [{
      id: 'm-claimed',
      threadId: 't-claimed',
      subject: 'Claimed message',
      from: 'Sender <sender@example.com>',
      snippet: 'hello',
      headers: {},
    }];

    assert.equal(claimProcessing('m-claimed'), true);

    const results = await scan('me@example.com', {
      adapter: makeAdapter(messages),
      config: { scan: { max_messages: 10 } },
      classifyEmailFn: async () => ({ archive: false, confidence: 90, summary: 'keep' }),
    });

    assert.equal(results.length, 0);
    assert.equal(listEmailItems({ limit: 10 }).items.length, 0);
  });

  it('does not leave processing claims behind after dry-run scans', async () => {
    const messages = [{
      id: 'm-dry-run',
      threadId: 't-dry-run',
      subject: 'Dry run message',
      from: 'Sender <sender@example.com>',
      snippet: 'hello',
      headers: {},
    }];

    const results = await scan('me@example.com', {
      adapter: makeAdapter(messages),
      config: { scan: { max_messages: 10 } },
      dryRun: true,
      classifyEmailFn: async () => ({ archive: false, confidence: 90, summary: 'keep' }),
    });

    assert.equal(results.length, 1);
    const state = loadState();
    assert.deepEqual(state.processingIds, {});
    assert.equal(state.processedIds.includes('m-dry-run'), false);
    assert.equal(listEmailItems({ limit: 10 }).items.length, 0);
  });

  it('suppresses hooks, push, and feed when those side effects are disabled', async () => {
    const messages = [{
      id: 'm-rescan',
      threadId: 't-rescan',
      subject: 'Rescan message',
      from: 'Sender <sender@example.com>',
      snippet: 'hello',
      headers: {},
    }];

    let hookCalls = 0;
    let pushCalls = 0;
    let feedCalls = 0;

    const results = await scan('me@example.com', {
      adapter: makeAdapter(messages),
      config: { scan: { max_messages: 10 } },
      skipProcessedCheck: true,
      runHooks: false,
      sendPush: false,
      postToFeed: false,
      classifyEmailFn: async () => ({ archive: false, confidence: 90, summary: 'keep' }),
      runActionHooksFn: async () => {
        hookCalls++;
        return { suppressFeed: false, triggeredRules: ['rule-1'] };
      },
      maybeSendPushFn: async () => {
        pushCalls++;
      },
      postEmailFeedFn: async () => {
        feedCalls++;
        return true;
      },
    });

    assert.equal(results.length, 1);
    assert.equal(hookCalls, 0);
    assert.equal(pushCalls, 0);
    assert.equal(feedCalls, 0);
    assert.equal(listEvents({ limit: 20 }).filter(event => event.eventType === 'email.action_hook_ran').length, 0);
  });

  it('can rescan without duplicating processing stats or scan events', async () => {
    const messages = [{
      id: 'm-rescan-stats',
      threadId: 't-rescan-stats',
      subject: 'Rescan stats message',
      from: 'Sender <sender@example.com>',
      snippet: 'hello',
      headers: {},
    }];

    const results = await scan('me@example.com', {
      adapter: makeAdapter(messages),
      config: { scan: { max_messages: 10 } },
      skipProcessedCheck: true,
      runHooks: false,
      sendPush: false,
      postToFeed: false,
      recordProcessing: false,
      classifyEmailFn: async () => ({ archive: true, confidence: 90, summary: 'archive' }),
    });

    assert.equal(results.length, 1);
    const state = loadState();
    assert.equal(state.stats.totalProcessed, 0);
    assert.equal(state.processedIds.includes('m-rescan-stats'), false);
    assert.equal(listEmailItems({ limit: 10 }).items.length, 0);
    assert.equal(listEvents({ limit: 20 }).length, 0);
  });

  it('records per-account scan health after empty scans', async () => {
    const results = await scan('me@example.com', {
      adapter: makeAdapter([]),
      config: { scan: { max_messages: 10 } },
      postToFeed: false,
      sendPush: false,
      runHooks: false,
    });

    assert.equal(results.length, 0);
    const state = loadState();
    assert.equal(typeof state.lastScanByAccount['me@example.com'], 'string');
    assert.deepEqual(state.lastScanCountsByAccount['me@example.com'], {
      scannedAt: state.lastScanByAccount['me@example.com'],
      unreadFound: 0,
      processed: 0,
    });
  });

  it('persists deterministic exact-rule attribution for actual scan handling', async () => {
    const messages = [{
      id: 'm-attributed', threadId: 't-attributed', subject: 'Receipt',
      from: 'Receipts <receipts@example.com>', snippet: 'Paid', headers: {},
    }];
    await scan('me@example.com', {
      adapter: makeAdapter(messages),
      config: { scan: { max_messages: 10 } },
      listAssistantRulesFn: () => [{
        id: 'rule-receipts', account: 'me@example.com', effect: 'archive',
        matcherKind: 'sender', matcherValue: 'receipts@example.com',
        description: 'Archive routine receipts', source: 'assistant', enabled: true,
      }],
      postToFeed: false, sendPush: false, runHooks: false,
    });

    const item = listEmailItems({ limit: 1 }).items[0];
    assert.equal(item.handlingDecision.effect, 'archive');
    assert.equal(item.handlingDecision.basis, 'exact_rule');
    assert.equal(item.handlingDecision.appliedRule.id, 'rule-receipts');
    assert.equal(item.handlingDecision.appliedRule.attribution, 'deterministic');
  });

  it('records ephemeral as the handling basis when it overrides a keep result', async () => {
    const messages = [{
      id: 'm-ephemeral', threadId: 't-ephemeral', subject: 'Code 123456',
      from: 'Security <security@example.com>', snippet: 'Verification code 123456', headers: {},
    }];
    await scan('me@example.com', {
      adapter: makeAdapter(messages),
      config: { scan: { max_messages: 10 } },
      classifyEmailFn: async () => ({
        archive: false, confidence: 95, reason: 'Short-lived verification code',
        summary: 'Verification code', handling: 'keep', ephemeral: true,
        decisionBasis: 'semantic_rule',
        appliedRule: {
          id: 'semantic-code', description: 'Verification codes', scope: 'user',
          source: 'assistant', editable: true, attribution: 'model_cited',
        },
      }),
      postToFeed: false, sendPush: false, runHooks: false,
    });

    const item = listEmailItems({ limit: 1 }).items[0];
    assert.equal(item.handlingDecision.effect, 'archive');
    assert.equal(item.handlingDecision.basis, 'ephemeral');
    assert.equal(item.handlingDecision.appliedRule, undefined);
    assert.equal(item.handling, 'archive');
  });
});
