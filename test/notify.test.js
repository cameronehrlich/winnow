import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatEmailFeedMessage, postEmailFeed } from '../src/notify.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  recordDelivery,
  upsertEmailItemFromResult,
} from '../src/store.js';

let tempDir;
let originalFetch;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-notify-'));
  process.env.WINNOW_STATE_PATH = join(tempDir, 'state.json');
  configureDatabaseForTests(join(tempDir, 'winnow.db'));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
  delete process.env.WINNOW_STATE_PATH;
});

describe('formatEmailFeedMessage', () => {
  const base = {
    from: '"John Smith" <john@example.com>',
    subject: 'Hello world',
    threadId: '18f1234abc',
    account: 'john@example.com',
    summary: 'A friendly hello',
    confidence: 85,
  };

  it('formats archived emails with text and blocks', () => {
    const msg = formatEmailFeedMessage({ ...base, archive: true });
    assert.equal(typeof msg.text, 'string');
    assert.ok(msg.text.startsWith('🗂️'));
    assert.ok(msg.text.includes('*John Smith*'));
    assert.ok(msg.text.includes('Hello world'));
    assert.ok(msg.text.includes('A friendly hello'));
    assert.ok(msg.text.includes('mail.google.com'));
    assert.ok(Array.isArray(msg.blocks));
    assert.equal(msg.blocks.at(-1).type, 'actions');
  });

  it('formats kept emails with inbox text and archive button', () => {
    const msg = formatEmailFeedMessage({ ...base, archive: false });
    assert.ok(msg.text.startsWith('📥'));
    assert.ok(msg.text.includes('*John Smith*'));
    assert.ok(msg.text.includes('Hello world'));
    assert.ok(!msg.text.includes('Archived'));
    assert.ok(!msg.text.includes('85%'));
    assert.equal(msg.blocks[0].type, 'section');
    assert.equal(msg.blocks[1].elements[0].action_id, 'winnow_archive');
  });

  it('formats OTP emails with code', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      archive: true,
      ephemeral: true,
      extractedCode: '482901',
    });
    assert.ok(msg.text.startsWith('🔑'));
    assert.ok(msg.text.includes('`482901`'));
    assert.ok(msg.text.includes('auto-archived'));
  });

  it('formats ephemeral FYI emails with summary', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      archive: true,
      ephemeral: true,
      summary: 'Package delivered to front door',
    });
    assert.ok(msg.text.startsWith('📌'));
    assert.ok(msg.text.includes('Package delivered to front door'));
    assert.ok(!msg.text.includes('Archived ('));
  });

  it('OTP takes precedence over generic ephemeral', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      archive: true,
      ephemeral: true,
      extractedCode: '1234',
      summary: 'Your verification code',
    });
    assert.ok(msg.text.startsWith('🔑'));
    assert.ok(msg.text.includes('`1234`'));
  });

  it('handles missing threadId without Gmail link', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      threadId: null,
      archive: false,
    });
    assert.ok(msg.text.includes('Hello world'));
    assert.ok(!msg.text.includes('mail.google.com'));
  });

  it('handles missing subject', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      subject: null,
      archive: false,
    });
    assert.ok(msg.text.includes('(no subject)'));
  });

  it('handles email-only from address', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      from: 'noreply@amazon.com',
      archive: true,
    });
    assert.ok(msg.text.includes('*noreply*'));
  });

  it('handles missing from', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      from: null,
      archive: false,
    });
    assert.ok(msg.text.includes('*Unknown*'));
  });

  it('escapes untrusted sender and subject mrkdwn', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      from: '<!here>',
      subject: '<https://evil.example|Click me> *now*',
      archive: false,
    });
    const blockText = msg.blocks[0].text.text;
    assert.ok(!blockText.includes('<!here>'));
    assert.ok(!blockText.includes('<https://evil.example|Click me>'));
    assert.ok(blockText.includes('&lt;!here&gt;'));
    assert.ok(blockText.includes('&lt;https://evil.example¦Click me&gt; now'));
  });

  it('does not post a second Slack card when a sent delivery record already exists', async () => {
    const item = upsertEmailItemFromResult({
      ...base,
      messageId: 'm-existing',
      archive: false,
    }, {
      account: base.account,
      messageId: 'm-existing',
      threadId: base.threadId,
      timestamp: '2026-06-29T16:00:00.000Z',
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
      return { json: async () => ({ ok: true, ts: '1710000001.000000' }) };
    };

    const posted = await postEmailFeed({
      ...base,
      emailItemId: item.id,
      messageId: 'm-existing',
      archive: false,
    });

    assert.equal(posted, true);
    assert.equal(fetchCalls, 0);
  });
});
