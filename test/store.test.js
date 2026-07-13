import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  appendEmailEvent,
  closeStoreForTests,
  configureDatabaseForTests,
  ensureStore,
  getDailyActionSummary,
  getLifetimeActionSummary,
  getMailboxCounts,
  listPushDevices,
  listDeliveryRecords,
  registerPushDevice,
  recordDelivery,
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
  it('rotates APNs tokens by stable installation and tracks environments', () => {
    const first = registerPushDevice({
      deviceToken: 'a'.repeat(64),
      installationId: '11111111-1111-1111-1111-111111111111',
      environment: 'development',
      bundleId: 'com.example.Winnow',
      appVersion: '1.0 (1)',
    });
    const rotated = registerPushDevice({
      deviceToken: 'b'.repeat(64),
      installationId: '11111111-1111-1111-1111-111111111111',
      environment: 'production',
      bundleId: 'com.example.Winnow',
      appVersion: '1.1 (2)',
    });
    assert.equal(first.id, rotated.id);
    const devices = listPushDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceToken, 'b'.repeat(64));
    assert.equal(devices[0].environment, 'production');
    assert.equal(devices[0].appVersion, '1.1 (2)');
  });

  it('reports inbox and archived counts for badge payloads', () => {
    upsertEmailItemFromResult({ account: 'me@example.com', messageId: 'm-in', threadId: 't-in', archive: false });
    upsertEmailItemFromResult({ account: 'me@example.com', messageId: 'm-arch', threadId: 't-arch', archive: true });
    assert.deepEqual(getMailboxCounts(), { inbox: 1, archived: 1 });
  });

  it('migrates an existing email store to add read state', () => {
    const path = join(tempDir, 'winnow.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE email_items (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        gmail_message_id TEXT,
        gmail_thread_id TEXT,
        from_name TEXT,
        from_email TEXT,
        subject TEXT,
        snippet TEXT,
        summary TEXT,
        action TEXT,
        deadline TEXT,
        impact TEXT,
        handling TEXT,
        reason TEXT,
        confidence INTEGER,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        low_confidence_kept INTEGER NOT NULL DEFAULT 0,
        triage_state TEXT NOT NULL DEFAULT 'kept',
        mailbox_state TEXT NOT NULL DEFAULT 'unknown',
        unsubscribe_url TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(account, gmail_message_id)
      )
    `);
    legacy.close();

    ensureStore();
    const inspector = new DatabaseSync(path, { readOnly: true });
    const columns = inspector.prepare('PRAGMA table_info(email_items)').all();
    inspector.close();
    assert.ok(columns.some(column => column.name === 'read_state'));
  });

  it('round-trips native-client read state without guessing unknown values', () => {
    const unread = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-unread',
      threadId: 't-unread',
      from: 'Sender <sender@example.com>',
      subject: 'Unread',
      archive: false,
      readState: 'unread',
    });
    const unknown = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-unknown',
      threadId: 't-unknown',
      from: 'Sender <sender@example.com>',
      subject: 'Unknown',
      archive: false,
    });

    assert.equal(unread.readState, 'unread');
    assert.equal(unread.isRead, false);
    assert.equal(unknown.readState, 'unknown');
    assert.equal(unknown.isRead, null);
  });

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

    appendEmailEvent('email.scanned', kept, {
      source: 'test',
      timestamp: '2026-06-30T17:00:00.000Z',
    });
    appendEmailEvent('email.kept', kept, {
      source: 'test',
      timestamp: '2026-06-30T17:00:00.000Z',
    });
    const lifetime = getLifetimeActionSummary({ recentLimit: 2 });
    assert.equal(lifetime.scope, 'lifetime');
    assert.equal(lifetime.counters.processed, 3);
    assert.equal(lifetime.recentActivity.length, 2);
    assert.equal(lifetime.recentActivity[0].timestamp, '2026-06-30T17:00:00.000Z');
    assert.equal(lifetime.recentActivity[0].emailItemId, kept.id);
  });

  it('upserts Slack delivery records for the same email item', () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-delivery',
      threadId: 't-delivery',
      from: 'Sender <sender@example.com>',
      subject: 'Delivery',
      archive: false,
    }, {
      account: 'me@example.com',
      messageId: 'm-delivery',
      threadId: 't-delivery',
      timestamp: '2026-06-29T16:00:00.000Z',
    });

    recordDelivery({
      emailItemId: item.id,
      sink: 'slack',
      channelId: 'C1',
      messageTs: '1710000000.000000',
    });
    recordDelivery({
      emailItemId: item.id,
      sink: 'slack',
      channelId: 'C1',
      messageTs: '1710000001.000000',
    });

    const records = listDeliveryRecords(item.id, 'slack');
    assert.equal(records.length, 1);
    assert.equal(records[0].messageTs, '1710000001.000000');
  });

  it('tracks mailto unsubscribe attempts separately from successful unsubscribes', () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-attempted',
      threadId: 't-attempted',
      from: 'Sender <sender@example.com>',
      subject: 'Attempted unsubscribe',
      archive: true,
    }, {
      account: 'me@example.com',
      messageId: 'm-attempted',
      threadId: 't-attempted',
      timestamp: '2026-06-29T16:00:00.000Z',
    });

    appendEmailEvent('email.unsubscribe_attempted', item, {
      source: 'test',
      timestamp: '2026-06-29T19:00:00.000Z',
    });

    const summary = getDailyActionSummary({ date: '2026-06-29' });
    assert.equal(summary.counters.unsubscribedSucceeded, 0);
    assert.equal(summary.counters.unsubscribedFailed, 0);
    assert.equal(summary.counters.unsubscribedAttempted, 1);
    assert.equal(summary.lists.unsubscribed.length, 1);
  });
});
