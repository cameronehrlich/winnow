import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchEmailAttachment, fetchEmailAttachments, fetchEmailContent } from '../src/email-content.js';

describe('on-demand email content', () => {
  it('loads the exact account thread and converts HTML-only mail to readable text', async () => {
    const calls = [];
    const adapter = {
      async getThread(account, threadId) {
        calls.push({ account, threadId });
        return {
          messages: [{
            id: 'm1',
            from: 'Billing <billing@example.com>',
            to: 'Me <me@example.com>',
            subject: 'Payment failed',
            date: 'Sun, 13 Jul 2026 15:42:00 -0700',
            body: '<html><body><h1>Payment failed</h1><p>Update card ending in 2171.</p></body></html>',
          }],
        };
      },
    };

    const content = await fetchEmailContent({
      id: 'email-1', account: 'me@example.com', threadId: 't1', messageId: 'm1', subject: 'Payment failed',
    }, { adapter });

    assert.deepEqual(calls, [{ account: 'me@example.com', threadId: 't1' }]);
    assert.equal(content.focusedMessageId, 'm1');
    assert.equal(content.messages[0].body, 'Payment failed\nUpdate card ending in 2171.');
    assert.equal(content.truncated, false);
  });

  it('bounds unusually large message bodies before returning them to the phone', async () => {
    const adapter = {
      async getThread() {
        return { messages: [{ id: 'm1', body: 'x'.repeat(250_000) }] };
      },
    };
    const content = await fetchEmailContent({
      id: 'email-1', account: 'me@example.com', threadId: 't1', subject: 'Large',
    }, { adapter });

    assert.equal(content.messages[0].body.length, 100_000);
    assert.equal(content.truncated, true);
  });

  it('normalizes exact-message fallback responses when no thread ID is indexed', async () => {
    const adapter = {
      async getMessage(account, messageId) {
        assert.equal(account, 'me@example.com');
        assert.equal(messageId, 'm2');
        return {
          body: 'Exact fallback body',
          headers: { from: 'Sender <sender@example.com>', to: 'Me <me@example.com>', subject: 'Fallback' },
          message: { id: 'm2', threadId: 't2', labelIds: ['INBOX'] },
        };
      },
    };
    const content = await fetchEmailContent({
      id: 'email-2', account: 'me@example.com', messageId: 'm2', subject: 'Fallback',
    }, { adapter });

    assert.equal(content.focusedMessageId, 'm2');
    assert.equal(content.messages[0].id, 'm2');
    assert.equal(content.messages[0].from, 'Sender <sender@example.com>');
    assert.equal(content.messages[0].body, 'Exact fallback body');
  });

  it('adds the selected message when a bounded thread response omits it', async () => {
    const adapter = {
      async getThread() { return { messages: [{ id: 'newer', body: 'Newer message' }] }; },
      async getMessage() { return { id: 'selected', body: 'Selected message' }; },
    };
    const content = await fetchEmailContent({
      id: 'email-3', account: 'me@example.com', threadId: 't3', messageId: 'selected', subject: 'Thread',
    }, { adapter });

    assert.equal(content.messages.some(message => message.id === 'selected'), true);
  });

  it('returns canonical thread attachment metadata without downloading bytes', async () => {
    let downloads = 0;
    const adapter = {
      async getThread(account, threadId) {
        assert.equal(account, 'me@example.com');
        assert.equal(threadId, 't1');
        return { messages: [{
          id: 'earlier',
          attachments: [{
            messageId: 'earlier', attachmentId: 'pdf-1', filename: 'invoice.pdf',
            mimeType: 'application/pdf', sizeBytes: 120,
          }],
        }] };
      },
      async getAttachment() { downloads += 1; },
    };
    const item = { id: 'email-1', account: 'me@example.com', threadId: 't1', messageId: 'later' };
    const attachments = await fetchEmailAttachments(item, { adapter });
    assert.deepEqual(attachments, [{
      messageId: 'earlier', attachmentId: 'pdf-1', filename: 'invoice.pdf',
      mimeType: 'application/pdf', sizeBytes: 120,
    }]);
    assert.equal(downloads, 0);
  });

  it('downloads only an attachment freshly verified in the exact item thread', async () => {
    const calls = [];
    const adapter = {
      async getThread() {
        return { messages: [{
          id: 'earlier',
          attachments: [{
            messageId: 'earlier', attachmentId: 'pdf-1', filename: 'invoice.pdf',
            mimeType: 'application/pdf', sizeBytes: 120,
          }],
        }] };
      },
      async getAttachment(account, messageId, attachmentId, options) {
        calls.push({ account, messageId, attachmentId, options });
        return Buffer.from('%PDF-test');
      },
    };
    const item = { id: 'email-1', account: 'me@example.com', threadId: 't1', messageId: 'later' };
    const result = await fetchEmailAttachment(item, 'pdf-1', { adapter });
    assert.equal(result.attachment.messageId, 'earlier');
    assert.equal(result.data.toString(), '%PDF-test');
    assert.deepEqual(calls, [{
      account: 'me@example.com', messageId: 'earlier', attachmentId: 'pdf-1', options: { maxBytes: 120 },
    }]);

    await assert.rejects(fetchEmailAttachment(item, 'not-in-thread', { adapter }), /attachment_not_found/);
    assert.equal(calls.length, 1);
  });

  it('resolves a rotating provider attachment locator through unique cached metadata', async () => {
    const adapter = {
      async getThread() {
        return { messages: [{
          id: 'earlier',
          attachments: [{
            messageId: 'earlier', attachmentId: 'fresh-provider-id', filename: 'invoice.pdf',
            mimeType: 'application/pdf', sizeBytes: 120,
          }],
        }] };
      },
      async getAttachment(account, messageId, attachmentId) {
        assert.equal(account, 'me@example.com');
        assert.equal(messageId, 'earlier');
        assert.equal(attachmentId, 'fresh-provider-id');
        return Buffer.from('%PDF-test');
      },
    };
    const item = {
      id: 'email-1', account: 'me@example.com', threadId: 't1', messageId: 'later',
      attachments: [{
        messageId: 'earlier', attachmentId: 'cached-provider-id', filename: 'invoice.pdf',
        mimeType: 'application/pdf', sizeBytes: 120,
      }],
    };

    const result = await fetchEmailAttachment(item, 'cached-provider-id', { adapter });
    assert.equal(result.attachment.attachmentId, 'fresh-provider-id');
    assert.equal(result.data.toString(), '%PDF-test');
  });
});
