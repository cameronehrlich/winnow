import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatEmailFeedMessage } from '../src/notify.js';

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
});
