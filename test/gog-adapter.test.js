import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GogAdapter, normalizeGogMessage } from '../src/adapters/gog.js';

function fakeAdapter(responses) {
  const calls = [];
  const adapter = new GogAdapter({
    command: '/fake/gog',
    execute: async (command, args, options) => {
      calls.push({ command, args, options });
      const response = typeof responses === 'function' ? responses(args) : responses.shift();
      return { stdout: JSON.stringify(response ?? {}) };
    },
  });
  return { adapter, calls };
}

describe('GogAdapter assistant primitives', () => {
  it('normalizes bounded mailbox search results without fetching bodies', async () => {
    const { adapter, calls } = fakeAdapter([{
      messages: [{
        id: 'm1',
        threadId: 't1',
        snippet: 'Your order shipped',
        labelIds: ['INBOX'],
        payload: { headers: [
          { name: 'Subject', value: 'Order 123' },
          { name: 'From', value: 'Store <orders@example.com>' },
          { name: 'To', value: 'me@example.com' },
        ] },
        body: 'must not be returned by metadata search',
      }],
      nextPageToken: 'next-1',
    }]);

    const result = await adapter.searchMailbox('me@example.com', 'order 123', 10);
    assert.equal(result.nextPageToken, 'next-1');
    assert.deepEqual(result.messages[0], {
      id: 'm1',
      messageId: 'm1',
      threadId: 't1',
      snippet: 'Your order shipped',
      subject: 'Order 123',
      from: 'Store <orders@example.com>',
      to: 'me@example.com',
      cc: '',
      date: '',
      labelIds: ['INBOX'],
      historyId: '',
      internalDate: '',
      headers: {
        subject: 'Order 123',
        from: 'Store <orders@example.com>',
        to: 'me@example.com',
      },
      body: '',
    });
    assert.deepEqual(calls[0].args, [
      'gmail', 'messages', 'search', 'order 123', '--max', '10', '--account', 'me@example.com',
      '--json', '--no-input',
    ]);
  });

  it('supports complete inbox snapshots and incremental Gmail history', async () => {
    const { adapter, calls } = fakeAdapter([
      { messages: [{ id: 'm1', threadId: 't1', labels: ['INBOX', 'UNREAD'] }] },
      { history: [{ id: '12', messagesAdded: [{ message: { id: 'm2', threadId: 't2' } }] }], historyId: '12' },
    ]);

    const snapshot = await adapter.searchAllMailbox('me@example.com', 'in:inbox', 500);
    const history = await adapter.getHistory('me@example.com', '10', 500);

    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.messages[0].labelIds, ['INBOX', 'UNREAD']);
    assert.equal(history.historyId, '12');
    assert.deepEqual(calls[0].args, [
      'gmail', 'messages', 'search', 'in:inbox', '--max', '500', '--all',
      '--account', 'me@example.com', '--json', '--no-input',
    ]);
    assert.deepEqual(calls[1].args, [
      'gmail', 'history', '--since', '10', '--max', '500', '--all',
      '--account', 'me@example.com', '--json', '--no-input',
    ]);
  });

  it('normalizes a full thread and decodes MIME text bodies', async () => {
    const encoded = Buffer.from('Latest reply body').toString('base64url');
    const { adapter } = fakeAdapter([{ thread: {
      id: 'thread1',
      historyId: 'history1',
      messages: [{
        id: 'message1',
        threadId: 'thread1',
        payload: {
          headers: [{ name: 'From', value: 'sender@example.com' }],
          parts: [{ mimeType: 'text/plain', body: { data: encoded } }],
        },
      }],
    } }]);

    const thread = await adapter.getThread('me@example.com', 'thread1');
    assert.equal(thread.id, 'thread1');
    assert.equal(thread.historyId, 'history1');
    assert.equal(thread.messages[0].body, 'Latest reply body');
    assert.equal(thread.messages[0].from, 'sender@example.com');
  });

  it('sends an exact reply only when reply is explicitly invoked', async () => {
    const { adapter, calls } = fakeAdapter([{ id: 'sent1', threadId: 'thread1' }]);
    const body = '  Confirmed body with $(not-a-shell)\n';
    const result = await adapter.reply('me@example.com', { messageId: 'message1' }, {
      body,
      to: ['person@example.com'],
      cc: ['copy@example.com'],
    });

    assert.equal(result.id, 'sent1');
    assert.equal(calls[0].command, '/fake/gog');
    assert.deepEqual(calls[0].args, [
      'gmail', 'reply', 'message1', '--body', body, '--no-quote', '--account', 'me@example.com',
      '--to', 'person@example.com', '--cc', 'copy@example.com', '--json', '--no-input',
    ]);
    assert.equal(calls[0].args.includes('--force'), false);
  });

  it('sends an exact forward with validated recipients and attachment choice', async () => {
    const { adapter, calls } = fakeAdapter([{ id: 'sent2' }]);
    await adapter.forward('me@example.com', { messageId: 'message1' }, {
      to: ['one@example.com', 'two@example.com'],
      bcc: 'audit@example.com',
      note: ' FYI\n',
      skipAttachments: true,
    });

    assert.deepEqual(calls[0].args, [
      'gmail', 'forward', 'message1', '--to', 'one@example.com,two@example.com',
      '--account', 'me@example.com', '--bcc', 'audit@example.com', '--note', ' FYI\n',
      '--skip-attachments', '--json', '--no-input',
    ]);
  });

  it('rejects unbounded or ambiguous outbound fields before execution', async () => {
    const { adapter, calls } = fakeAdapter([]);
    await assert.rejects(
      adapter.forward('me@example.com', { messageId: 'message1' }, { to: 'Name <person@example.com>' }),
      /to\[0\] is invalid/,
    );
    await assert.rejects(
      adapter.reply('me@example.com', { messageId: '../message' }, { body: 'hello' }),
      /messageId is invalid/,
    );
    await assert.rejects(adapter.searchMailbox('me@example.com', 'x', 101), /limit/);
    assert.equal(calls.length, 0);
  });

  it('bounds normalized bodies', () => {
    const normalized = normalizeGogMessage({ id: 'm1', body: 'x'.repeat(200_000) });
    assert.equal(normalized.body.length, 100_000);
  });

  it('unfolds and trims malformed whitespace in message headers', () => {
    const normalized = normalizeGogMessage({
      id: 'm1',
      subject: '\n  Follow-up work ready\n\tfor your approval  ',
      from: '\n Belong <hello@example.com> ',
    });
    assert.equal(normalized.subject, 'Follow-up work ready for your approval');
    assert.equal(normalized.from, 'Belong <hello@example.com>');
  });

  it('keeps top-level body and headers from wrapped gmail get responses', () => {
    const message = normalizeGogMessage({
      body: 'Complete exact body',
      headers: { from: 'Sender <sender@example.com>', subject: 'Exact message' },
      message: { id: 'm-exact', threadId: 't-exact', labelIds: ['INBOX'] },
    });
    assert.equal(message.id, 'm-exact');
    assert.equal(message.from, 'Sender <sender@example.com>');
    assert.equal(message.subject, 'Exact message');
    assert.equal(message.body, 'Complete exact body');
  });

  it('never includes malformed gog output or email bodies in parse-error logs', async () => {
    const logged = [];
    const originalError = console.error;
    console.error = (...values) => logged.push(values.join(' '));
    try {
      const adapter = new GogAdapter({
        execute: async () => ({ stdout: 'private body: account number 123, not JSON' }),
      });
      assert.deepEqual(await adapter.searchMailbox('me@example.com', 'account', 5), {
        messages: [],
        nextPageToken: null,
      });
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(logged, ['[winnow] Failed to parse gog JSON output']);
  });
});
