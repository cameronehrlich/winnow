import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveEmail, moveEmailToInbox } from '../src/actions.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  listEvents,
  upsertEmailItemFromResult,
} from '../src/store.js';

let tempDir;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-actions-'));
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
});

afterEach(() => {
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
});

describe('email actions', () => {
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
});
