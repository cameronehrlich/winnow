import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatEmailFeedMessage } from '../src/notify.js';

describe('formatEmailFeedMessage', () => {
  const base = {
    from: '"John Smith" <john@example.com>',
    subject: 'Hello world',
    threadId: '18f1234abc',
    summary: 'A friendly hello',
    confidence: 85,
  };

  it('formats archived emails with 🗂️, confidence, and summary', () => {
    const msg = formatEmailFeedMessage({ ...base, archive: true });
    assert.ok(msg.startsWith('🗂️'));
    assert.ok(msg.includes('*John Smith*'));
    assert.ok(msg.includes('Hello world'));
    assert.ok(msg.includes('Archived (85%)'));
    assert.ok(msg.includes('A friendly hello'));
    // Should have Gmail link
    assert.ok(msg.includes('mail.google.com'));
  });

  it('formats kept emails with 📥 and no confidence/summary', () => {
    const msg = formatEmailFeedMessage({ ...base, archive: false });
    assert.ok(msg.startsWith('📥'));
    assert.ok(msg.includes('*John Smith*'));
    assert.ok(msg.includes('Hello world'));
    // Should NOT have confidence or summary line
    assert.ok(!msg.includes('Archived'));
    assert.ok(!msg.includes('85%'));
  });

  it('formats OTP emails with 🔑 and extracted code', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      archive: true,
      ephemeral: true,
      extractedCode: '482901',
    });
    assert.ok(msg.startsWith('🔑'));
    assert.ok(msg.includes('`482901`'));
    assert.ok(msg.includes('copied to clipboard'));
    assert.ok(msg.includes('auto-archived'));
  });

  it('formats ephemeral FYI emails with 📌 and summary', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      archive: true,
      ephemeral: true,
      summary: 'Package delivered to front door',
    });
    assert.ok(msg.startsWith('📌'));
    assert.ok(msg.includes('Package delivered to front door'));
    assert.ok(msg.includes('auto-archived'));
    // Should NOT show confidence or "Archived (X%)"
    assert.ok(!msg.includes('Archived ('));
  });

  it('OTP takes precedence over generic ephemeral', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      archive: true,
      ephemeral: true,
      extractedCode: '1234',
      summary: 'Your verification code',
    });
    // Should be 🔑 not 📌
    assert.ok(msg.startsWith('🔑'));
    assert.ok(msg.includes('`1234`'));
  });

  it('handles missing threadId (no Gmail link)', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      threadId: null,
      archive: false,
    });
    assert.ok(msg.includes('Hello world'));
    assert.ok(!msg.includes('mail.google.com'));
  });

  it('handles missing subject', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      subject: null,
      archive: false,
    });
    assert.ok(msg.includes('(no subject)'));
  });

  it('handles email-only from (no display name)', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      from: 'noreply@amazon.com',
      archive: true,
    });
    assert.ok(msg.includes('*noreply*'));
  });

  it('handles missing from', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      from: null,
      archive: false,
    });
    assert.ok(msg.includes('*Unknown*'));
  });

  it('archived with missing confidence shows ?', () => {
    const msg = formatEmailFeedMessage({
      ...base,
      archive: true,
      confidence: undefined,
    });
    assert.ok(msg.includes('Archived (?%)'));
  });
});
