import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fullSyncGmailInbox, syncGmailMailbox } from '../src/gmail-sync.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  findEmailItemByGmail,
  getGmailFullSyncAt,
  getGmailHistoryCursor,
  setGmailFullSyncAt,
  setGmailHistoryCursor,
  upsertEmailItemFromResult,
} from '../src/store.js';

let tempDir;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-gmail-sync-'));
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
});

afterEach(() => {
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
});

function fullMessage({ id, labels, historyId = '99', internalDate = '1720000000000' }) {
  return {
    body: 'Body is fetched but never persisted by the sync import.',
    headers: { from: 'Sender <sender@example.com>', subject: `Subject ${id}` },
    message: { id, threadId: `t-${id}`, labelIds: labels, historyId, internalDate, snippet: `Snippet ${id}` },
  };
}

describe('durable Gmail synchronization', () => {
  it('imports read inbox mail conservatively and classifies missed unread mail', async () => {
    const classified = [];
    const adapter = {
      searchAllMailbox: async () => ({
        complete: true,
        messages: [
          { id: 'm-read', threadId: 't-m-read', labelIds: ['INBOX'] },
          { id: 'm-unread', threadId: 't-m-unread', labelIds: ['INBOX', 'UNREAD'] },
        ],
      }),
      searchMailbox: async () => ({ messages: [{ id: 'm-unread', threadId: 't-m-unread' }] }),
      getMessage: async (_account, id) => fullMessage({
        id,
        labels: id === 'm-unread' ? ['INBOX', 'UNREAD'] : ['INBOX'],
      }),
    };

    const result = await fullSyncGmailInbox('me@example.com', {
      adapter,
      scanFn: async (_account, options) => { classified.push(...options.messages); return []; },
      syncSlackFn: async () => ({ updated: 0 }),
    });

    assert.equal(result.imported, 1);
    assert.equal(result.classified, 1);
    assert.deepEqual(classified.map(message => message.id), ['m-unread']);
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'm-read' }).readState, 'read');
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'm-unread' }), null);
    assert.equal(getGmailHistoryCursor('me@example.com'), '99');
    assert.ok(getGmailFullSyncAt('me@example.com'));
  });

  it('uses Gmail history after seeding and imports newly discovered read mail', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async (_account, since) => {
        assert.equal(since, '10');
        return {
          history: [{ id: '12', messagesAdded: [{ message: { id: 'm-new', threadId: 't-m-new' } }] }],
          historyId: '12',
        };
      },
      getMessage: async () => fullMessage({ id: 'm-new', labels: ['INBOX'], historyId: '12' }),
    };

    const result = await syncGmailMailbox('me@example.com', {
      adapter,
      scanFn: async () => { throw new Error('read messages should not be classified'); },
      syncSlackFn: async () => ({ updated: 0 }),
    });

    assert.equal(result.mode, 'history');
    assert.equal(result.imported, 1);
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'm-new' }).mailboxState, 'inbox');
    assert.equal(getGmailHistoryCursor('me@example.com'), '12');
  });

  it('falls back to a full sync when Gmail expires the history cursor', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async () => { throw new Error('HTTP 404: startHistoryId is too old'); },
      searchMailbox: async () => ({ messages: [{ id: 'latest', threadId: 't-latest' }] }),
      searchAllMailbox: async () => ({ complete: true, messages: [] }),
      getMessage: async () => fullMessage({ id: 'latest', labels: [], historyId: '20' }),
    };

    const result = await syncGmailMailbox('me@example.com', {
      adapter,
      scanFn: async () => [],
      syncSlackFn: async () => ({ updated: 0 }),
    });

    assert.equal(result.mode, 'full');
    assert.equal(getGmailHistoryCursor('me@example.com'), '20');
  });

  it('advances past an untracked deleted history message', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async () => ({
        history: [{ id: '12', messagesDeleted: [{ message: { id: 'gone', threadId: 't-gone' } }] }],
        historyId: '12',
      }),
      getMessage: async () => { throw new Error('message not found'); },
    };

    const result = await syncGmailMailbox('me@example.com', {
      adapter,
      scanFn: async () => [],
      syncSlackFn: async () => ({ updated: 0 }),
    });

    assert.equal(result.checked, 1);
    assert.equal(getGmailHistoryCursor('me@example.com'), '12');
  });

  it('removes stale local inbox membership during a complete fallback sync', async () => {
    const stale = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-stale', threadId: 't-stale', archive: false,
    });
    const slackUpdates = [];
    const adapter = {
      searchAllMailbox: async () => ({ complete: true, messages: [] }),
      searchMailbox: async () => ({ messages: [] }),
    };

    const result = await fullSyncGmailInbox('me@example.com', {
      adapter,
      scanFn: async () => [],
      syncSlackFn: async item => { slackUpdates.push(item.id); return { updated: 1 }; },
    });

    assert.equal(result.changed, 1);
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'm-stale' }).mailboxState, 'archived');
    assert.deepEqual(slackUpdates, [stale.id]);
  });
});
