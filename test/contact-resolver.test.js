import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTrackedContacts } from '../src/contact-resolver.js';
import { reloadConfig } from '../src/config.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  upsertEmailItemFromResult,
  upsertGmailMessageMetadata,
} from '../src/store.js';

let tempDir;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-contacts-'));
  process.env.WINNOW_CONFIG_PATH = join(tempDir, 'config.yaml');
  writeFileSync(process.env.WINNOW_CONFIG_PATH, 'accounts:\n  - me@example.com\n  - work@example.com\n');
  reloadConfig();
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
});

afterEach(() => {
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
  delete process.env.WINNOW_CONFIG_PATH;
});

describe('contact resolution', () => {
  it('finds sent To, Cc and Bcc recipients, preserves quoted names, and deduplicates mailbox addresses', () => {
    upsertGmailMessageMetadata('me@example.com', {
      id: 'sent-1', threadId: 'sent-1', labelIds: ['SENT'],
      from: 'Me <me@example.com>',
      to: '"Ehrlich, Riley" <RILEY@example.com>, Paul <paul@example.com>',
      cc: 'Riley <riley@example.com>; Jose <jose@example.com>',
      bcc: 'Private Recipient <private@example.com>',
      subject: 'Private subject', snippet: 'Private content',
    });
    const riley = resolveTrackedContacts('Riley', { account: 'me@example.com' });
    assert.equal(riley.length, 1);
    assert.equal(riley[0].name, 'Ehrlich, Riley');
    assert.equal(riley[0].email, 'riley@example.com');
    assert.equal(riley[0].messageCount, 1);
    assert.equal(resolveTrackedContacts('Paul')[0].email, 'paul@example.com');
    assert.equal(resolveTrackedContacts('Jose')[0].email, 'jose@example.com');
    assert.equal(resolveTrackedContacts('Private Recipient')[0].email, 'private@example.com');
    assert.doesNotMatch(JSON.stringify(riley), /Private subject|Private content/);
  });

  it('scopes to the relevant account and excludes retired mailboxes and unsafe addresses', () => {
    for (const account of ['work@example.com', 'removed@example.com']) {
      upsertGmailMessageMetadata(account, {
        id: 'scoped', threadId: 'scoped', labelIds: ['SENT'],
        to: 'Jo <jo@example.com>, Invalid <not-an-email>',
      });
    }
    assert.deepEqual(resolveTrackedContacts('Jo', { account: 'me@example.com' }), []);
    assert.deepEqual(resolveTrackedContacts('Jo', { account: 'removed@example.com' }), []);
    assert.deepEqual(resolveTrackedContacts('Jo')[0].accounts, ['work@example.com']);
    assert.deepEqual(resolveTrackedContacts('Invalid'), []);
  });

  it('does not double count an indexed and tracked copy of the same message', () => {
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'duplicate', threadId: 'duplicate', from: 'Riley <riley@example.com>',
    });
    upsertGmailMessageMetadata('me@example.com', {
      id: 'duplicate', threadId: 'duplicate', from: 'riley@example.com', to: 'me@example.com',
    });
    const [candidate] = resolveTrackedContacts('riley');
    assert.equal(candidate.messageCount, 1);
    assert.equal(candidate.name, 'Riley');
  });

  it('ignores Spam, Trash and Draft-only metadata', () => {
    for (const label of ['SPAM', 'TRASH', 'DRAFT']) {
      upsertGmailMessageMetadata('me@example.com', {
        id: label, threadId: label, labelIds: [label], to: 'Ignore <ignore@example.com>',
      });
    }
    assert.deepEqual(resolveTrackedContacts('Ignore'), []);
  });

  it('does not suggest contacts from a removed mailbox', () => {
    upsertEmailItemFromResult({
      account: 'removed@example.com', messageId: 'removed', threadId: 'removed',
      from: 'Former Contact <former@example.com>',
    });
    assert.deepEqual(resolveTrackedContacts('Former Contact'), []);
  });

  it('ranks exact recent correspondents without exposing message content', () => {
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'r1', threadId: 'r1',
      from: 'Riley Ehrlich <riley@example.com>', subject: 'Receipt', summary: 'Private summary',
    }, { timestamp: '2026-07-12T10:00:00.000Z' });
    upsertEmailItemFromResult({
      account: 'work@example.com', messageId: 'r2', threadId: 'r2',
      from: 'Riley Ehrlich <riley@example.com>', subject: 'FYI',
    }, { timestamp: '2026-07-13T10:00:00.000Z' });
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'o1', threadId: 'o1',
      from: 'Riley Other <other@example.com>', subject: 'Other',
    });

    const candidates = resolveTrackedContacts('Riley Ehrlich');

    assert.equal(candidates[0].email, 'riley@example.com');
    assert.equal(candidates[0].messageCount, 2);
    assert.deepEqual(candidates[0].accounts.sort(), ['me@example.com', 'work@example.com']);
    assert.doesNotMatch(JSON.stringify(candidates), /Private summary|Receipt|FYI/);
  });

  it('returns no candidate instead of guessing an unrelated address', () => {
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm1', threadId: 'm1',
      from: 'Different Person <different@example.com>',
    });
    assert.deepEqual(resolveTrackedContacts('Riley'), []);
  });
});
