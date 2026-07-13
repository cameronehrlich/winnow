import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcileMailbox } from '../src/reconcile.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  getEmailItem,
  listEvents,
  upsertEmailItemFromResult,
} from '../src/store.js';

let tempDir;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-reconcile-'));
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
});

afterEach(() => {
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
});

describe('mailbox reconciliation', () => {
  it('silently hydrates migrated unknown read state', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-hydrate',
      threadId: 't-hydrate',
      from: 'Sender <sender@example.com>',
      subject: 'Hydrate read state',
      archive: false,
      readState: 'unknown',
    });
    const adapter = {
      getMailboxState: async () => ({ mailboxState: 'inbox', unread: true, labels: ['INBOX', 'UNREAD'] }),
    };

    const result = await reconcileMailbox({ account: item.account, adapter });

    assert.equal(result.checked, 1);
    assert.equal(result.changed, 0);
    assert.equal(getEmailItem(item.id).readState, 'unread');
    assert.equal(listEvents({ limit: 10 }).length, 0);
  });

  it('records a real known read-state transition', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-transition',
      threadId: 't-transition',
      from: 'Sender <sender@example.com>',
      subject: 'Read state changed',
      archive: false,
      readState: 'unread',
    });
    const adapter = {
      getMailboxState: async () => ({ mailboxState: 'inbox', unread: false, labels: ['INBOX'] }),
    };

    const result = await reconcileMailbox({ account: item.account, adapter });

    assert.equal(result.changed, 1);
    assert.equal(getEmailItem(item.id).readState, 'read');
    assert.equal(listEvents({ limit: 10 })[0].eventType, 'mailbox.state_changed');
  });
});
