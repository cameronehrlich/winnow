import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeEmailUnsubscribe } from '../src/unsubscribe.js';

describe('email unsubscribe execution', () => {
  it('falls back to a semantically labelled body link when the stored header link fails', async () => {
    const attempts = [];
    const result = await executeEmailUnsubscribe({
      account: 'person@example.com',
      messageId: 'message-1',
      unsubscribeLink: 'https://sender.example/broken-header-link',
    }, {
      async getMessage() {
        return {
          unsubscribe: 'https://sender.example/broken-header-link',
          body: '<a href="https://sender.example/working-footer-link">Unsubscribe</a>',
        };
      },
      async follow(url) {
        attempts.push(url);
        if (url.includes('broken-header')) throw new Error('GET returned HTTP 302');
        return { status: 'succeeded', method: 'link', note: 'Submitted', urlHost: 'sender.example' };
      },
    });

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(attempts, [
      'https://sender.example/broken-header-link',
      'https://sender.example/working-footer-link',
    ]);
  });

  it('still uses the stored method if live message discovery is unavailable', async () => {
    const result = await executeEmailUnsubscribe({
      account: 'person@example.com',
      messageId: 'message-1',
      unsubscribeLink: 'https://sender.example/unsubscribe',
    }, {
      async getMessage() { throw new Error('mail provider unavailable'); },
      async follow() {
        return { status: 'succeeded', method: 'one-click', note: 'GET 200', urlHost: 'sender.example' };
      },
    });

    assert.equal(result.status, 'succeeded');
  });

  it('prefers an automatable footer link over a stored mailto method', async () => {
    const attempts = [];
    const result = await executeEmailUnsubscribe({
      account: 'person@example.com',
      messageId: 'message-1',
      unsubscribeLink: 'mailto:leave@example.com',
    }, {
      async getMessage() {
        return {
          unsubscribe: 'mailto:leave@example.com',
          body: '<a href="https://sender.example/leave">Manage email preferences</a>',
        };
      },
      async follow(url) {
        attempts.push(url);
        return { status: 'succeeded', method: 'link', note: 'Submitted', urlHost: 'sender.example' };
      },
    });

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(attempts, ['https://sender.example/leave']);
  });

  it('returns a browser handoff when every validated web method is HTTP-blocked', async () => {
    const result = await executeEmailUnsubscribe({
      account: 'person@example.com',
      messageId: 'message-1',
      unsubscribeLink: 'https://sender.example/unsubscribe',
    }, {
      async getMessage() {
        return { unsubscribe: 'https://sender.example/unsubscribe' };
      },
      async follow() {
        throw new Error('GET returned HTTP 403');
      },
    });

    assert.deepEqual(result, {
      status: 'attempted',
      method: 'browser',
      note: 'Sender requires completion in a browser',
      urlHost: 'sender.example',
      manualActionUrl: 'https://sender.example/unsubscribe',
    });
  });

  it('does not offer a browser handoff for a blocked unsafe URL', async () => {
    await assert.rejects(
      () => executeEmailUnsubscribe({
        account: 'person@example.com',
        messageId: 'message-1',
        unsubscribeLink: 'https://sender.example/unsubscribe',
      }, {
        async getMessage() {
          return { unsubscribe: 'https://sender.example/unsubscribe' };
        },
        async follow() {
          throw new Error('Blocked unsafe unsubscribe URL address');
        },
      }),
      /Blocked unsafe unsubscribe URL address/
    );
  });
});
