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

  it('processes the compact message ID array returned by gog history', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const fetched = [];
    const adapter = {
      getHistory: async () => ({
        historyId: '13',
        messages: ['m-read', 'm-unread'],
        nextPageToken: '',
      }),
      getMessage: async (_account, id) => {
        fetched.push(id);
        return fullMessage({
          id,
          labels: id === 'm-unread' ? ['INBOX', 'UNREAD'] : ['INBOX'],
          historyId: '13',
        });
      },
    };
    const classified = [];

    const result = await syncGmailMailbox('me@example.com', {
      adapter,
      scanFn: async (_account, options) => { classified.push(...options.messages); return []; },
      syncSlackFn: async () => ({ updated: 0 }),
    });

    assert.deepEqual(fetched, ['m-read', 'm-unread']);
    assert.equal(result.checked, 2);
    assert.equal(result.imported, 1);
    assert.equal(result.classified, 1);
    assert.deepEqual(classified.map(message => message.id), ['m-unread']);
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'm-read' }).mailboxState, 'inbox');
    assert.equal(getGmailHistoryCursor('me@example.com'), '13');
  });

  it('applies an external Gmail archive reported by the compact history response', async () => {
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-archived', threadId: 't-m-archived', archive: false,
      readState: 'unread',
    });
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async () => ({ historyId: '14', messages: ['m-archived'] }),
      getMessage: async () => fullMessage({ id: 'm-archived', labels: [], historyId: '14' }),
    };

    const result = await syncGmailMailbox('me@example.com', {
      adapter,
      scanFn: async () => [],
      syncSlackFn: async () => ({ updated: 0 }),
    });

    const item = findEmailItemByGmail({ account: 'me@example.com', messageId: 'm-archived' });
    assert.equal(item.mailboxState, 'archived');
    assert.equal(item.readState, 'read');
    assert.equal(result.changed, 1);
    assert.deepEqual(result.changes.map(change => change.id), [item.id]);
    assert.equal(getGmailHistoryCursor('me@example.com'), '14');
  });

  it('does not advance the history cursor when a changed message cannot be fetched', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async () => ({ historyId: '13', messages: ['m-ok', 'm-failed'] }),
      getMessage: async (_account, id) => {
        if (id === 'm-failed') throw new Error('Gmail temporarily unavailable');
        return fullMessage({ id, labels: ['INBOX'], historyId: '13' });
      },
    };

    await assert.rejects(
      syncGmailMailbox('me@example.com', {
        adapter,
        scanFn: async () => [],
        syncSlackFn: async () => ({ updated: 0 }),
      }),
      /temporarily unavailable/,
    );

    assert.equal(getGmailHistoryCursor('me@example.com'), '10');
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'm-ok' }).mailboxState, 'inbox');
  });

  it('does not advance the history cursor for an incomplete message response', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async () => ({ historyId: '13', messages: ['m-incomplete'] }),
      getMessage: async () => ({}),
    };

    await assert.rejects(
      syncGmailMailbox('me@example.com', {
        adapter,
        scanFn: async () => [],
        syncSlackFn: async () => ({ updated: 0 }),
      }),
      /incomplete or mismatched/,
    );

    assert.equal(getGmailHistoryCursor('me@example.com'), '10');
  });

  it('treats a missing compact-history message as deleted and advances safely', async () => {
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-gone', threadId: 't-m-gone', archive: false,
    });
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async () => ({ historyId: '12', messages: ['m-gone'] }),
      getMessage: async () => { throw new Error('HTTP 404: message not found'); },
    };

    const result = await syncGmailMailbox('me@example.com', {
      adapter,
      scanFn: async () => [],
      syncSlackFn: async () => ({ updated: 0 }),
    });

    assert.equal(result.checked, 1);
    assert.equal(result.changed, 1);
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'm-gone' }).mailboxState, 'archived');
    assert.equal(getGmailHistoryCursor('me@example.com'), '12');
  });

  it('falls back to a full snapshot rather than accepting truncated history', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    let historyMessageFetches = 0;
    const adapter = {
      getHistory: async () => ({
        historyId: '20',
        messages: ['m-not-complete'],
        nextPageToken: 'more-results',
      }),
      searchMailbox: async () => ({ messages: [{ id: 'latest', threadId: 't-latest' }] }),
      searchAllMailbox: async () => ({ complete: true, messages: [] }),
      getMessage: async (_account, id) => {
        if (id === 'm-not-complete') historyMessageFetches++;
        return fullMessage({ id, labels: [], historyId: '21' });
      },
    };

    const result = await syncGmailMailbox('me@example.com', {
      adapter,
      scanFn: async () => [],
      syncSlackFn: async () => ({ updated: 0 }),
    });

    assert.equal(result.mode, 'full');
    assert.equal(historyMessageFetches, 0);
    assert.equal(getGmailHistoryCursor('me@example.com'), '21');
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
