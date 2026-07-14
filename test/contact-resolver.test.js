import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTrackedContacts } from '../src/contact-resolver.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  upsertEmailItemFromResult,
} from '../src/store.js';

let tempDir;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-contacts-'));
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
});

afterEach(() => {
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
});

describe('contact resolution', () => {
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
