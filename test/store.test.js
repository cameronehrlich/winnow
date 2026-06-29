import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendEmailEvent,
  closeStoreForTests,
  configureDatabaseForTests,
  getDailyActionSummary,
  upsertEmailItemFromResult,
} from '../src/store.js';

let tempDir;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-store-'));
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
});

afterEach(() => {
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
});

describe('daily action summary', () => {
  it('counts scan, archive, kept, restore, and unsubscribe events by Los Angeles day', () => {
    const archived = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-archived',
      threadId: 't-archived',
      from: 'Sender <sender@example.com>',
      subject: 'Archived',
      summary: 'Archived summary',
      archive: true,
      confidence: 91,
      ephemeral: true,
    }, {
      account: 'me@example.com',
      messageId: 'm-archived',
      threadId: 't-archived',
      timestamp: '2026-06-29T16:00:00.000Z',
    });

    const kept = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-kept',
      threadId: 't-kept',
      from: 'Human <human@example.com>',
      subject: 'Kept',
      summary: 'Kept summary',
      archive: false,
      confidence: 60,
    }, {
      account: 'me@example.com',
      messageId: 'm-kept',
      threadId: 't-kept',
      timestamp: '2026-06-29T17:00:00.000Z',
    });

    appendEmailEvent('email.scanned', archived, { source: 'test', timestamp: '2026-06-29T16:00:00.000Z' });
    appendEmailEvent('email.auto_archived', archived, { source: 'test', timestamp: '2026-06-29T16:00:00.000Z' });
    appendEmailEvent('email.scanned', kept, { source: 'test', timestamp: '2026-06-29T17:00:00.000Z' });
    appendEmailEvent('email.kept', kept, { source: 'test', timestamp: '2026-06-29T17:00:00.000Z' });
    appendEmailEvent('email.restored_to_inbox', archived, { source: 'test', timestamp: '2026-06-29T18:00:00.000Z' });
    appendEmailEvent('email.unsubscribed', archived, { source: 'test', timestamp: '2026-06-29T19:00:00.000Z' });

    const summary = getDailyActionSummary({ date: '2026-06-29' });
    assert.equal(summary.counters.processed, 2);
    assert.equal(summary.counters.autoArchived, 1);
    assert.equal(summary.counters.kept, 1);
    assert.equal(summary.counters.restoredToInbox, 1);
    assert.equal(summary.counters.unsubscribedSucceeded, 1);
    assert.equal(summary.counters.ephemeral, 1);
    assert.equal(summary.counters.lowConfidenceKept, 1);
    assert.equal(summary.lists.archived.length, 1);
    assert.equal(summary.lists.kept.length, 1);
    assert.equal(summary.lists.restored.length, 1);
    assert.equal(summary.lists.unsubscribed.length, 1);
  });
});
