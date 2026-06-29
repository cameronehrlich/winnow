import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadState, recordUnsubscribe } from '../src/state.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  listEvents,
  upsertEmailItemFromResult,
} from '../src/store.js';

let tempDir;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-state-'));
  process.env.WINNOW_STATE_PATH = join(tempDir, 'state.json');
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
});

afterEach(() => {
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
  delete process.env.WINNOW_STATE_PATH;
});

describe('unsubscribe state tracking', () => {
  it('does not append duplicate events for the same unsubscribe action', () => {
    upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm1',
      threadId: 't1',
      from: 'Sender <sender@example.com>',
      subject: 'Promo',
      archive: true,
    }, {
      account: 'me@example.com',
      messageId: 'm1',
      threadId: 't1',
      timestamp: '2026-06-29T16:00:00.000Z',
    });

    const entry = {
      sender: 'Sender <sender@example.com>',
      subject: 'Promo',
      account: 'me@example.com',
      threadId: 't1',
      source: 'slack-button',
      method: 'one-click',
      status: 'succeeded',
      note: 'GET 200',
      sourceMessageId: '1710000000.000000',
      timestamp: '2026-06-29T17:00:00.000Z',
    };

    const first = recordUnsubscribe(entry);
    const second = recordUnsubscribe({
      ...entry,
      timestamp: '2026-06-30T17:00:00.000Z',
    });

    const entries = loadState().stats.unsubscribes.entries;
    assert.equal(entries.length, 1);
    assert.equal(second.id, first.id);
    assert.equal(entries[0].timestamp, '2026-06-29T17:00:00.000Z');
    assert.equal(listEvents({ limit: 10 }).length, 1);
  });
});
