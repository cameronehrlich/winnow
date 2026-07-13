import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claimProcessing, findUnsubscribeForEmail, loadState, localDateString, markProcessed, recordUnsubscribe, releaseProcessing, updateState } from '../src/state.js';
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
  it('buckets unsubscribe counters by Los Angeles day', () => {
    recordUnsubscribe({
      sender: 'Sender <sender@example.com>',
      subject: 'Promo',
      account: 'me@example.com',
      threadId: 't-la-day',
      source: 'manual',
      method: 'form',
      status: 'succeeded',
      note: 'Backfilled near UTC midnight',
      timestamp: '2026-07-11T06:30:00.000Z',
    });

    const daily = loadState().stats.unsubscribes.daily;
    assert.equal(localDateString('2026-07-11T06:30:00.000Z'), '2026-07-10');
    assert.equal(daily['2026-07-10'].total, 1);
    assert.equal(daily['2026-07-11'], undefined);
  });

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
    assert.equal(findUnsubscribeForEmail({
      account: entry.account,
      threadId: entry.threadId,
      sender: entry.sender,
    })?.status, 'succeeded');
  });
});

describe('processing claims', () => {
  it('claims a message once and clears the claim after markProcessed', () => {
    assert.equal(claimProcessing('m-claim'), true);
    assert.equal(claimProcessing('m-claim'), false);

    markProcessed('m-claim', { archive: false, confidence: 80 });

    const state = loadState();
    assert.ok(state.processedIds.includes('m-claim'));
    assert.equal(state.processingIds['m-claim'], undefined);
    assert.equal(claimProcessing('m-claim'), false);
  });

  it('releases an in-flight claim after failure paths', () => {
    assert.equal(claimProcessing('m-release'), true);
    assert.equal(releaseProcessing('m-release'), true);
    assert.equal(claimProcessing('m-release'), true);
  });

  it('preserves processing data during unrelated locked state updates', () => {
    assert.equal(claimProcessing('m-active'), true);
    markProcessed('m-done', { archive: true, confidence: 91 });

    updateState(state => {
      state.lastScanTime = '2026-07-09T12:00:00.000Z';
      if (!state.lastScanByAccount) state.lastScanByAccount = {};
      state.lastScanByAccount['me@example.com'] = state.lastScanTime;
    });

    const state = loadState();
    assert.equal(state.lastScanTime, '2026-07-09T12:00:00.000Z');
    assert.ok(state.processedIds.includes('m-done'));
    assert.equal(typeof state.processingIds['m-active'], 'string');
  });
});
