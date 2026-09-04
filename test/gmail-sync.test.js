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
  getGmailMessageMetadata,
  getGmailFullSyncAt,
  getGmailHistoryCursor,
  setGmailFullSyncAt,
  setGmailHistoryCursor,
  listSentThreadRepresentatives,
  upsertGmailMessageMetadata,
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

  it('indexes external Sent history idempotently without creating triage records', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async () => ({ historyId: '12', messages: ['m-sent'] }),
      getMessage: async () => fullMessage({ id: 'm-sent', labels: ['SENT'], historyId: '12' }),
    };

    const first = await syncGmailMailbox('me@example.com', {
      adapter, scanFn: async () => [], syncSlackFn: async () => ({ updated: 0 }),
    });
    const second = await syncGmailMailbox('me@example.com', {
      adapter, scanFn: async () => [], syncSlackFn: async () => ({ updated: 0 }),
    });

    assert.equal(first.imported, 0);
    assert.equal(first.classified, 0);
    assert.equal(second.imported, 0);
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'm-sent' }), null);
    assert.equal(getGmailMessageMetadata('me@example.com', 'm-sent').direction, 'sent');
    assert.deepEqual(listSentThreadRepresentatives({ accounts: ['me@example.com'] })
      .map(item => item.messageId), ['m-sent']);
    assert.equal(getGmailHistoryCursor('me@example.com'), '12');
  });

  it('keeps the existing Inbox flow for a self-sent SENT plus INBOX message', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async () => ({ historyId: '12', messages: ['m-self'] }),
      getMessage: async () => fullMessage({ id: 'm-self', labels: ['SENT', 'INBOX'], historyId: '12' }),
    };
    const result = await syncGmailMailbox('me@example.com', {
      adapter, scanFn: async () => [], syncSlackFn: async () => ({ updated: 0 }),
    });

    assert.equal(result.imported, 1);
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'm-self' }).mailboxState, 'inbox');
    assert.equal(getGmailMessageMetadata('me@example.com', 'm-self').direction, 'sent');
  });

  it('hides a cached Sent row when history reports that SENT was removed', async () => {
    upsertGmailMessageMetadata('me@example.com', {
      id: 'm-unsent', threadId: 't-m-unsent', labelIds: ['SENT'], internalDate: '1720000000000',
    });
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async () => ({ historyId: '12', messages: ['m-unsent'] }),
      getMessage: async () => fullMessage({ id: 'm-unsent', labels: [], historyId: '12' }),
    };
    await syncGmailMailbox('me@example.com', {
      adapter, scanFn: async () => [], syncSlackFn: async () => ({ updated: 0 }),
    });
    assert.equal(getGmailMessageMetadata('me@example.com', 'm-unsent').direction, 'received');
    assert.deepEqual(listSentThreadRepresentatives({ accounts: ['me@example.com'] }), []);
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

  it('performs a bounded recent-Sent catch-up during an expired-history fallback', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const searches = [];
    const adapter = {
      getHistory: async () => { throw new Error('HTTP 404: startHistoryId is too old'); },
      searchMailbox: async (_account, query, limit) => {
        searches.push({ query, limit });
        return query === 'in:anywhere'
          ? { messages: [{ id: 'latest', threadId: 't-latest' }] }
          : { messages: [{ id: 'recent-sent', threadId: 't-recent-sent', labelIds: ['SENT'] }] };
      },
      searchAllMailbox: async () => ({ complete: true, messages: [] }),
      getMessage: async (_account, id) => id === 'latest'
        ? fullMessage({ id, labels: [], historyId: '20' })
        : {
            ...fullMessage({ id, labels: ['SENT'], historyId: '20' }),
            headers: {
              from: 'Me <me@example.com>', to: 'Recipient <recipient@example.com>', subject: 'Recent sent',
            },
          },
    };

    const result = await syncGmailMailbox('me@example.com', {
      adapter, scanFn: async () => [], syncSlackFn: async () => ({ updated: 0 }),
    });
    assert.equal(result.mode, 'full');
    assert.deepEqual(searches, [
      { query: 'in:anywhere', limit: 1 },
      { query: 'in:sent', limit: 50 },
    ]);
    assert.equal(getGmailMessageMetadata('me@example.com', 'recent-sent').direction, 'sent');
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'recent-sent' }), null);
    assert.equal(getGmailHistoryCursor('me@example.com'), '20');
  });

  it('keeps the cursor unchanged when strict Sent catch-up fails during full fallback', async () => {
    setGmailHistoryCursor('me@example.com', '10');
    setGmailFullSyncAt('me@example.com');
    const adapter = {
      getHistory: async () => { throw new Error('HTTP 404: startHistoryId is too old'); },
      searchMailbox: async (_account, query) => query === 'in:anywhere'
        ? { messages: [{ id: 'latest', threadId: 't-latest' }] }
        : { messages: [{ id: 'sent-fails', threadId: 't-sent-fails', labelIds: ['SENT'] }] },
      searchAllMailbox: async () => ({ complete: true, messages: [] }),
      getMessage: async (_account, id) => {
        if (id === 'sent-fails') throw new Error('Gmail temporarily unavailable');
        return fullMessage({ id: 'latest', labels: [], historyId: '20' });
      },
    };

    await assert.rejects(syncGmailMailbox('me@example.com', {
      adapter, scanFn: async () => [], syncSlackFn: async () => ({ updated: 0 }),
    }), /temporarily unavailable/);
    assert.equal(getGmailHistoryCursor('me@example.com'), '10');
  });

  it('advances past an untracked deleted history message', async () => {
    upsertGmailMessageMetadata('me@example.com', {
      id: 'gone', threadId: 't-gone', labelIds: ['SENT'], internalDate: '1720000000000',
    });
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
    assert.equal(getGmailMessageMetadata('me@example.com', 'gone'), null);
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
