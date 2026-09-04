import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchEmailAttachment, fetchEmailAttachments, fetchEmailContent } from '../src/email-content.js';

describe('on-demand email content', () => {
  it('loads the exact account thread and returns plain and HTML bodies separately', async () => {
    const calls = [];
    const adapter = {
      async getThread(account, threadId) {
        calls.push({ account, threadId });
        return {
          messages: [{
            id: 'm1',
            from: 'Billing <billing@example.com>',
            to: 'Me <me@example.com>',
            cc: 'Bookkeeper <books@example.com>',
            bcc: 'Private archive <archive@example.com>',
            subject: 'Payment failed',
            date: 'Sun, 13 Jul 2026 15:42:00 -0700',
            body: '<html><body><h1>Payment failed</h1><p>Update card ending in 2171.</p></body></html>',
            htmlBody: '<html><body><h1>Payment failed</h1><p>Update card ending in 2171.</p></body></html>',
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
    assert.equal(content.messages[0].htmlBody, '<html><body><h1>Payment failed</h1><p>Update card ending in 2171.</p></body></html>');
    assert.equal(content.messages[0].cc, 'Bookkeeper <books@example.com>');
    assert.equal(content.messages[0].bcc, 'Private archive <archive@example.com>');
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
      async getMessage() { return { id: 'selected', threadId: 't3', body: 'Selected message' }; },
    };
    const content = await fetchEmailContent({
      id: 'email-3', account: 'me@example.com', threadId: 't3', messageId: 'selected', subject: 'Thread',
    }, { adapter });

    assert.equal(content.messages.some(message => message.id === 'selected'), true);
  });

  it('returns a deduplicated mixed-direction thread oldest first with message-scoped metadata', async () => {
    const adapter = {
      async getThread() {
        return { messages: [
          {
            id: 'sent-2', internalDate: '3000', date: 'Mon, 1 Jan 1990 00:00:00 +0000',
            labelIds: ['SENT'], from: 'Me <me@example.com>', to: 'Manager <manager@example.com>',
            subject: 'Re: Roof', snippet: 'Latest follow-up', body: 'Latest follow-up',
            attachments: [{
              messageId: 'sent-2', attachmentId: 'a-2', filename: 'quote.pdf',
              mimeType: 'application/pdf', sizeBytes: 42,
            }],
          },
          {
            id: 'received-1', internalDate: '1000', date: 'Mon, 1 Jan 2090 00:00:00 +0000',
            labelIds: ['INBOX'], from: 'Manager <manager@example.com>', to: 'Me <me@example.com>',
            subject: 'Roof', snippet: 'Original note', body: 'Original note',
          },
          {
            id: 'sent-1', internalDate: '2000', labelIds: ['SENT'],
            from: 'Me <me@example.com>', to: 'Manager <manager@example.com>',
            subject: 'Re: Roof', snippet: 'First reply', body: 'First reply',
          },
          // Duplicate provider records must not produce duplicate cards.
          { id: 'sent-1', internalDate: '2000', labelIds: ['SENT'], body: 'Duplicate' },
        ] };
      },
    };

    const content = await fetchEmailContent({
      id: 'email-roof', account: 'me@example.com', threadId: 'thread-roof',
      messageId: 'received-1', subject: 'Roof',
    }, { adapter });

    assert.deepEqual(content.messages.map(message => message.id), ['received-1', 'sent-1', 'sent-2']);
    assert.deepEqual(content.messages.map(message => message.direction), ['received', 'sent', 'sent']);
    assert.equal(content.messages[0].internalDate, '1000');
    assert.deepEqual(content.messages[2].labelIds, ['SENT']);
    assert.equal(content.messages[2].snippet, 'Latest follow-up');
    assert.deepEqual(content.messages[2].attachments, [{
      messageId: 'sent-2', attachmentId: 'a-2', filename: 'quote.pdf',
      mimeType: 'application/pdf', sizeBytes: 42,
    }]);
  });

  it('uses Date only when internalDate is invalid and resolves equal timestamps by message ID', async () => {
    const adapter = {
      async getThread() {
        return { messages: [
          { id: 'same-b', internalDate: '2000', date: 'Mon, 1 Jan 1900 00:00:00 +0000', body: 'B' },
          { id: 'undated-z', internalDate: 'invalid', date: 'also invalid', body: 'Z' },
          { id: 'date-fallback', internalDate: '', date: 'Thu, 01 Jan 1970 00:00:01 GMT', body: 'Fallback' },
          { id: 'same-a', internalDate: '2000', date: 'Mon, 1 Jan 2200 00:00:00 +0000', body: 'A' },
          { id: 'undated-a', body: 'Unknown' },
        ] };
      },
    };
    const content = await fetchEmailContent({
      id: 'email-order', account: 'me@example.com', threadId: 'thread-order', subject: 'Ordering',
    }, { adapter });

    assert.deepEqual(content.messages.map(message => message.id), [
      'date-fallback', 'same-a', 'same-b', 'undated-a', 'undated-z',
    ]);
  });

  it('does not expose a draft in the sent and received timeline', async () => {
    const adapter = {
      async getThread() {
        return { messages: [
          { id: 'received-1', internalDate: '1000', labelIds: ['INBOX'], body: 'Delivered' },
          { id: 'draft-1', internalDate: '2000', labelIds: ['SENT', 'DRAFT'], body: 'Not sent yet' },
        ] };
      },
    };
    const content = await fetchEmailContent({
      id: 'draft', account: 'me@example.com', threadId: 'thread-draft', subject: 'Draft',
    }, { adapter });
    assert.deepEqual(content.messages.map(message => message.id), ['received-1']);
  });

  it('rejects a missing focus message that belongs to a different Gmail thread', async () => {
    const adapter = {
      async getThread() { return { messages: [{ id: 'thread-message', threadId: 'expected', body: 'Expected' }] }; },
      async getMessage() { return { id: 'foreign', threadId: 'other', body: 'Private other thread' }; },
    };

    await assert.rejects(fetchEmailContent({
      id: 'email', account: 'me@example.com', threadId: 'expected', messageId: 'foreign', subject: 'Expected',
    }, { adapter }), /does not belong to the requested thread/);
  });

  it('retains the focused message and newest context when a thread exceeds its display limit', async () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({
      id: `message-${String(index).padStart(3, '0')}`,
      threadId: 'long-thread',
      internalDate: String((index + 1) * 1000),
      body: `Message ${index}`,
    }));
    const adapter = {
      async getThread() { return { messages }; },
      async getMessage() { return messages[0]; },
    };

    const content = await fetchEmailContent({
      id: 'email', account: 'me@example.com', threadId: 'long-thread',
      messageId: 'message-000', subject: 'Long thread',
    }, { adapter });

    assert.equal(content.messages.length, 100);
    assert.equal(content.messages[0].id, 'message-000');
    assert.equal(content.messages.at(-1).id, 'message-100');
    assert.equal(content.truncated, true);
  });

  it('discovers unsubscribe only from the focused message in a conversation', async () => {
    const adapter = {
      async getThread() {
        return { messages: [
          {
            id: 'earlier',
            htmlBody: '<a href="https://old.example.com/leave">Unsubscribe</a>',
          },
          {
            id: 'focused',
            htmlBody: '<a href="https://current.example.com/leave">Manage email preferences</a>',
          },
        ] };
      },
    };

    const content = await fetchEmailContent({
      id: 'email-4', account: 'me@example.com', threadId: 't4', messageId: 'focused', subject: 'Thread',
    }, { adapter });

    assert.equal(content.unsubscribeLink, 'https://current.example.com/leave');
  });

  it('does not borrow an unsubscribe link from an earlier message in the thread', async () => {
    const adapter = {
      async getThread() {
        return { messages: [
          {
            id: 'earlier',
            body: '<a href="https://old.example.com/leave">Unsubscribe</a>',
          },
          { id: 'focused', body: 'Thanks for getting back to me.' },
        ] };
      },
    };

    const content = await fetchEmailContent({
      id: 'email-5', account: 'me@example.com', threadId: 't5', messageId: 'focused', subject: 'Thread',
    }, { adapter });

    assert.equal(content.unsubscribeLink, '');
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
