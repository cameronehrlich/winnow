import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backfillRecentSentMetadata, listSentMailbox } from '../src/gmail-metadata.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  deleteGmailMessageMetadata,
  findEmailItemByGmail,
  getGmailMessageMetadata,
  getMailboxCounts,
  listSentThreadRepresentatives,
  upsertGmailMessageMetadata,
} from '../src/store.js';

let tempDir;
let databasePath;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-gmail-metadata-'));
  databasePath = join(tempDir, 'winnow.db');
  configureDatabaseForTests(databasePath);
});

afterEach(() => {
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
});

function metadata({
  id,
  threadId,
  labels = ['SENT'],
  internalDate,
  account = 'me@example.com',
  to = 'Recipient <recipient@example.com>',
  subject = 'Subject',
  body,
  htmlBody,
}) {
  return {
    account,
    id,
    messageId: id,
    threadId,
    labelIds: labels,
    from: `Me <${account}>`,
    to,
    cc: '',
    bcc: '',
    subject,
    snippet: `Snippet ${id}`,
    internalDate,
    date: '',
    body,
    htmlBody,
  };
}

describe('Gmail metadata index', () => {
  it('returns an empty mailbox when no Gmail accounts are configured', async () => {
    const result = await listSentMailbox({
      accounts: [],
      adapter: { searchMailbox: async () => assert.fail('No provider call expected') },
    });
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.accounts, []);
    assert.deepEqual(result.accountErrors, []);
  });

  it('groups Sent by account and thread using the newest stable representative', () => {
    upsertGmailMessageMetadata('me@example.com', metadata({
      id: 'sent-a1', threadId: 'thread-a', internalDate: '1000', subject: 'Old',
    }));
    upsertGmailMessageMetadata('me@example.com', metadata({
      id: 'sent-a2', threadId: 'thread-a', internalDate: '3000', subject: 'Newest',
    }));
    upsertGmailMessageMetadata('me@example.com', metadata({
      id: 'received-a', threadId: 'thread-a', labels: ['INBOX'], internalDate: '2000',
    }));
    upsertGmailMessageMetadata('other@example.com', metadata({
      account: 'other@example.com', id: 'sent-other', threadId: 'thread-a', internalDate: '4000',
    }));

    const all = listSentThreadRepresentatives({
      accounts: ['me@example.com', 'other@example.com'], limit: 10,
    });
    assert.deepEqual(all.map(item => [item.account, item.messageId]), [
      ['other@example.com', 'sent-other'],
      ['me@example.com', 'sent-a2'],
    ]);
    const mine = all[1];
    assert.equal(mine.sentMessageCount, undefined);
    assert.equal(mine.threadMessageCount, undefined);
    assert.equal(mine.indexedSentMessageCount, 2);
    assert.equal(mine.indexedThreadMessageCount, 3);
    assert.equal(mine.messageCountsComplete, false);
    assert.equal(mine.direction, 'sent');
    assert.equal(mine.timestamp, '1970-01-01T00:00:03.000Z');
    assert.equal(findEmailItemByGmail({ account: 'me@example.com', messageId: 'sent-a2' }), null);
    assert.deepEqual(getMailboxCounts(), { inbox: 0, archived: 0, archivedUnseen: 0 });
  });

  it('uses labels rather than sender text, excludes drafts, and removes lost/deleted Sent membership', () => {
    upsertGmailMessageMetadata('me@example.com', metadata({
      id: 'looks-sent', threadId: 'received-thread', labels: ['INBOX'], internalDate: '1000',
      to: 'Me <me@example.com>',
    }));
    upsertGmailMessageMetadata('me@example.com', metadata({
      id: 'draft', threadId: 'draft-thread', labels: ['SENT', 'DRAFT'], internalDate: '2000',
    }));
    upsertGmailMessageMetadata('me@example.com', metadata({
      id: 'removed', threadId: 'removed-thread', labels: ['SENT'], internalDate: '3000',
    }));
    assert.deepEqual(listSentThreadRepresentatives({ accounts: ['me@example.com'] })
      .map(item => item.messageId), ['removed']);

    upsertGmailMessageMetadata('me@example.com', metadata({
      id: 'removed', threadId: 'removed-thread', labels: [], internalDate: '3000',
    }));
    assert.deepEqual(listSentThreadRepresentatives({ accounts: ['me@example.com'] }), []);

    upsertGmailMessageMetadata('me@example.com', metadata({
      id: 'deleted', threadId: 'deleted-thread', labels: ['SENT'], internalDate: '4000',
    }));
    assert.equal(deleteGmailMessageMetadata('me@example.com', 'deleted'), true);
    assert.equal(getGmailMessageMetadata('me@example.com', 'deleted'), null);
  });

  it('never persists message bodies or HTML in the metadata-only database', () => {
    const plainSecret = 'BODY-SENTINEL-DO-NOT-PERSIST';
    const htmlSecret = 'HTML-SENTINEL-DO-NOT-PERSIST';
    const indexed = upsertGmailMessageMetadata('me@example.com', metadata({
      id: 'sent-secret', threadId: 'thread-secret', internalDate: '5000',
      body: plainSecret, htmlBody: `<p>${htmlSecret}</p>`,
    }));
    assert.equal(indexed.body, undefined);
    assert.equal(indexed.htmlBody, undefined);
    closeStoreForTests();
    const bytes = readFileSync(databasePath).toString('latin1');
    assert.equal(bytes.includes(plainSecret), false);
    assert.equal(bytes.includes(htmlSecret), false);
  });

  it('hydrates only returned cross-account representatives under one global cap and reuses the cache', async () => {
    let active = 0;
    let maxActive = 0;
    let hydrateCalls = 0;
    const accounts = ['first@example.com', 'second@example.com'];
    const summaries = new Map(accounts.map((account, accountIndex) => [account,
      Array.from({ length: 30 }, (_, index) => {
        const sequence = accountIndex * 30 + index;
        return {
          id: `sent-${sequence}`,
          threadId: `thread-${sequence}`,
          labelIds: ['SENT'],
          date: new Date(Date.UTC(2026, 0, 1, 0, sequence)).toUTCString(),
          from: `Me <${account}>`,
          subject: `Subject ${sequence}`,
        };
      }),
    ]));
    const adapter = {
      async searchMailbox(account, query, limit) {
        assert.equal(query, 'in:sent');
        assert.equal(limit, 50);
        return { messages: summaries.get(account) };
      },
      async getMessage(account, id) {
        hydrateCalls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active--;
        const index = Number(id.split('-')[1]);
        return metadata({
          account, id, threadId: `thread-${index}`,
          internalDate: String(Date.UTC(2026, 0, 1, 0, index)),
        });
      },
    };

    const first = await listSentMailbox({ accounts, limit: 7, adapter });
    assert.equal(first.items.length, 7);
    assert.equal(first.items[0].messageId, 'sent-59');
    assert.equal(hydrateCalls, 7);
    assert.ok(maxActive <= 4);
    assert.deepEqual(first.accountErrors, []);
    assert.equal(first.hydrationFailures, 0);

    await listSentMailbox({ accounts, limit: 7, adapter });
    assert.equal(hydrateCalls, 7);
  });

  it('hydrates one complete native page while bounding larger API requests', async () => {
    const accounts = ['first@example.com', 'second@example.com'];
    const hydrated = [];
    const adapter = {
      async searchMailbox(account, _query, limit) {
        assert.equal(limit, 100);
        const accountOffset = account === accounts[0] ? 0 : 100;
        return { messages: Array.from({ length: 100 }, (_, index) => {
          const sequence = accountOffset + index;
          return {
            id: `bulk-${sequence}`,
            threadId: `bulk-thread-${sequence}`,
            labelIds: ['SENT'],
            date: new Date(Date.UTC(2026, 0, 1, 0, sequence)).toUTCString(),
            from: `Me <${account}>`,
            subject: `Bulk ${sequence}`,
          };
        }) };
      },
      async getMessage(account, id) {
        hydrated.push(`${account}/${id}`);
        const sequence = Number(id.split('-')[1]);
        return metadata({
          account,
          id,
          threadId: `bulk-thread-${sequence}`,
          internalDate: String(Date.UTC(2026, 0, 1, 0, sequence)),
        });
      },
    };

    const result = await listSentMailbox({ accounts, limit: 200, adapter });
    assert.equal(result.items.length, 200);
    assert.equal(hydrated.length, 50);
    assert.equal(new Set(hydrated).size, 50);
    assert.equal(result.items.filter(item => item.to).length, 50);
    assert.equal(result.deferredHydrationCount, 150);
  });

  it('keeps healthy and cached accounts visible when one aggregate search fails', async () => {
    upsertGmailMessageMetadata('offline@example.com', metadata({
      account: 'offline@example.com', id: 'cached-sent', threadId: 'cached-thread',
      internalDate: '5000',
    }));
    const adapter = {
      async searchMailbox(account) {
        if (account === 'offline@example.com') throw new Error('provider unavailable');
        return { messages: [{
          id: 'healthy-sent', threadId: 'healthy-thread', labelIds: ['SENT'],
          date: new Date(4_000).toUTCString(), from: `Me <${account}>`, subject: 'Healthy',
        }] };
      },
      async getMessage(account, id) {
        return metadata({ account, id, threadId: 'healthy-thread', internalDate: '4000' });
      },
    };

    const aggregate = await listSentMailbox({
      accounts: ['healthy@example.com', 'offline@example.com'], limit: 10, adapter,
    });
    assert.deepEqual(aggregate.items.map(item => item.messageId), ['cached-sent', 'healthy-sent']);
    assert.deepEqual(aggregate.accountErrors, [{
      account: 'offline@example.com', error: 'sent_search_unavailable',
    }]);

    const cachedSelected = await listSentMailbox({
      accounts: ['offline@example.com'], limit: 10, adapter,
    });
    assert.deepEqual(cachedSelected.items.map(item => item.messageId), ['cached-sent']);
    assert.equal(cachedSelected.accountErrors.length, 1);

    await assert.rejects(listSentMailbox({
      accounts: ['missing@example.com'], limit: 10, adapter: {
        searchMailbox: async () => { throw new Error('provider unavailable'); },
      },
    }), /provider unavailable/);

    await assert.rejects(listSentMailbox({
      accounts: ['missing@example.com', 'also-missing@example.com'], limit: 10, adapter: {
        searchMailbox: async () => { throw new Error('provider unavailable'); },
      },
    }), /provider unavailable/);
  });

  it('treats a Sent message that disappears during strict hydration as deleted', async () => {
    const adapter = {
      async searchMailbox() {
        return { messages: [{
          id: 'vanished', threadId: 'vanished-thread', labels: ['SENT'],
          date: new Date(5_000).toUTCString(), subject: 'Vanished',
        }] };
      },
      async getMessage() { throw new Error('HTTP 404: message not found'); },
    };

    const result = await backfillRecentSentMetadata({
      account: 'me@example.com', limit: 50, adapter, strict: true,
    });

    assert.equal(result.failures, 0);
    assert.equal(getGmailMessageMetadata('me@example.com', 'vanished'), null);
    assert.deepEqual(listSentThreadRepresentatives({ accounts: ['me@example.com'] }), []);
  });
});
