import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveEmail, markEmailRead, markEmailUnread, moveEmailToInbox } from '../src/actions.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  getEmailItem,
  listEmailItems,
  listEvents,
  recordDelivery,
  upsertEmailItemFromResult,
} from '../src/store.js';

let tempDir;
let originalFetch;
let originalPath;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-actions-'));
  process.env.WINNOW_CONFIG_PATH = join(tempDir, 'config.yaml');
  writeFileSync(process.env.WINNOW_CONFIG_PATH, 'accounts:\n  - me@example.com\nslack:\n  channel_id: C123\n');
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
  originalFetch = globalThis.fetch;
  originalPath = process.env.PATH || '';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
  delete process.env.WINNOW_CONFIG_PATH;
  delete process.env.SLACK_BOT_TOKEN;
});

describe('email actions', () => {
  function installFakeGog() {
    const binDir = join(tempDir, 'bin');
    mkdirSync(binDir);
    const gogPath = join(binDir, 'gog');
    writeFileSync(gogPath, '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n');
    chmodSync(gogPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;
  }

  it('does not create duplicate archive events when item is already archived', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-archived',
      threadId: 't-archived',
      from: 'Sender <sender@example.com>',
      subject: 'Already archived',
      archive: true,
    }, {
      account: 'me@example.com',
      messageId: 'm-archived',
      threadId: 't-archived',
      timestamp: '2026-06-29T16:00:00.000Z',
    });

    const result = await archiveEmail({
      emailItemId: item.id,
      account: item.account,
      threadId: item.threadId,
      source: 'api',
    });

    assert.equal(result.id, item.id);
    assert.equal(listEvents({ limit: 10 }).length, 0);
  });

  it('does not reconcile Slack delivery from Slack-origin archive actions', async () => {
    installFakeGog();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    const item = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-slack-archive',
      threadId: 't-slack-archive',
      from: 'Sender <sender@example.com>',
      subject: 'Archive from Slack',
      archive: false,
    }, {
      account: 'me@example.com',
      messageId: 'm-slack-archive',
      threadId: 't-slack-archive',
      timestamp: '2026-07-09T16:00:00.000Z',
    });
    recordDelivery({
      emailItemId: item.id,
      sink: 'slack',
      channelId: 'C123',
      messageTs: '1710000000.000000',
    });

    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return { json: async () => ({ ok: true }) };
    };

    const result = await archiveEmail({
      emailItemId: item.id,
      account: item.account,
      threadId: item.threadId,
      messageId: item.messageId,
      source: 'slack',
      syncSlack: false,
    });

    assert.equal(result.mailboxState, 'archived');
    assert.equal(fetchCalls, 0);
  });

  it('keeps reconciling Slack delivery for non-Slack archive actions', async () => {
    installFakeGog();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    const item = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-api-archive',
      threadId: 't-api-archive',
      from: 'Sender <sender@example.com>',
      subject: 'Archive from API',
      archive: false,
    }, {
      account: 'me@example.com',
      messageId: 'm-api-archive',
      threadId: 't-api-archive',
      timestamp: '2026-07-09T16:00:00.000Z',
    });
    recordDelivery({
      emailItemId: item.id,
      sink: 'slack',
      channelId: 'C123',
      messageTs: '1710000000.000000',
    });

    const fetchCalls = [];
    globalThis.fetch = async (url, opts = {}) => {
      fetchCalls.push({ url, body: JSON.parse(opts.body) });
      return { json: async () => ({ ok: true }) };
    };

    const result = await archiveEmail({
      emailItemId: item.id,
      account: item.account,
      threadId: item.threadId,
      messageId: item.messageId,
      source: 'api',
    });

    assert.equal(result.mailboxState, 'archived');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://slack.com/api/chat.update');
    assert.equal(fetchCalls[0].body.channel, 'C123');
    assert.equal(fetchCalls[0].body.ts, '1710000000.000000');
  });

  it('does not create duplicate restore events when item is already in inbox', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-inbox',
      threadId: 't-inbox',
      from: 'Sender <sender@example.com>',
      subject: 'Already inbox',
      archive: false,
    }, {
      account: 'me@example.com',
      messageId: 'm-inbox',
      threadId: 't-inbox',
      timestamp: '2026-06-29T16:00:00.000Z',
    });

    const result = await moveEmailToInbox({
      emailItemId: item.id,
      account: item.account,
      threadId: item.threadId,
      source: 'api',
    });

    assert.equal(result.id, item.id);
    assert.equal(listEvents({ limit: 10 }).length, 0);
  });

  it('persists read and unread actions for API refreshes', async () => {
    installFakeGog();
    const item = upsertEmailItemFromResult({
      account: 'me@example.com',
      messageId: 'm-read-state',
      threadId: 't-read-state',
      from: 'Sender <sender@example.com>',
      subject: 'Read state',
      archive: false,
      readState: 'unread',
    }, {
      account: 'me@example.com',
      messageId: 'm-read-state',
      threadId: 't-read-state',
      timestamp: '2026-07-12T16:00:00.000Z',
    });

    const read = await markEmailRead({
      emailItemId: item.id,
      account: item.account,
      threadId: item.threadId,
      messageId: item.messageId,
      source: 'api',
    });
    assert.equal(read.readState, 'read');
    assert.equal(read.isRead, true);

    const unread = await markEmailUnread({
      emailItemId: item.id,
      account: item.account,
      threadId: item.threadId,
      messageId: item.messageId,
      source: 'api',
    });
    assert.equal(unread.readState, 'unread');
    assert.equal(unread.isRead, false);
    assert.equal(listEvents({ limit: 10 }).filter(event => event.eventType === 'mailbox.state_changed').length, 2);
  });

  it('keeps every tracked row in a Gmail thread consistent after actions', async () => {
    installFakeGog();
    const original = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-original', threadId: 't-shared',
      subject: 'Original', archive: false, readState: 'unread',
    }, { timestamp: '2026-07-12T15:00:00.000Z' });
    const reply = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-reply', threadId: 't-shared',
      subject: 'Re: Original', archive: false, readState: 'unread',
    }, { timestamp: '2026-07-12T16:00:00.000Z' });

    await archiveEmail({
      emailItemId: reply.id, account: reply.account, threadId: reply.threadId,
      messageId: reply.messageId, source: 'api', syncSlack: false,
    });
    assert.equal(getEmailItem(original.id).mailboxState, 'archived');
    assert.equal(getEmailItem(original.id).readState, 'read');
    assert.equal(listEmailItems({ state: 'archived' }).items.length, 1);

    await moveEmailToInbox({
      emailItemId: reply.id, account: reply.account, threadId: reply.threadId,
      messageId: reply.messageId, source: 'api', syncSlack: false,
    });
    assert.equal(getEmailItem(original.id).mailboxState, 'inbox');

    await markEmailUnread({
      emailItemId: reply.id, account: reply.account, threadId: reply.threadId,
      messageId: reply.messageId, source: 'api',
    });
    assert.equal(getEmailItem(original.id).readState, 'unread');
    assert.equal(getEmailItem(reply.id).readState, 'unread');
  });

  it('does not let an older archived row hide a newer inbox reply from an action', async () => {
    installFakeGog();
    const original = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-old-archived', threadId: 't-returned',
      subject: 'Original', archive: true, readState: 'read',
    }, { timestamp: '2026-07-12T15:00:00.000Z' });
    const reply = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-new-inbox', threadId: 't-returned',
      subject: 'Re: Original', archive: false, readState: 'unread',
    }, { timestamp: '2026-07-12T16:00:00.000Z' });

    await archiveEmail({
      emailItemId: original.id, account: original.account, threadId: original.threadId,
      messageId: original.messageId, source: 'slack', syncSlack: false,
    });

    assert.equal(getEmailItem(reply.id).mailboxState, 'archived');
    assert.equal(getEmailItem(reply.id).readState, 'read');
    assert.equal(listEvents({ limit: 10 }).filter(event => event.eventType === 'email.manual_archived').length, 1);
  });
});
