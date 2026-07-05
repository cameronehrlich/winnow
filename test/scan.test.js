import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scan } from '../src/scan.js';
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
});
