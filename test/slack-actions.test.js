import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { followUnsubscribeLink, validateUnsubscribeUrl } from '../src/slack-actions.js';

describe('unsubscribe URL safety', () => {
  it('allows mailto unsubscribe links without network validation', async () => {
    const url = await validateUnsubscribeUrl('mailto:unsubscribe@example.com');
    assert.equal(url.protocol, 'mailto:');
  });

  it('blocks localhost unsubscribe URLs', async () => {
    await assert.rejects(
      () => validateUnsubscribeUrl('http://localhost/unsubscribe'),
      /Blocked unsafe unsubscribe URL host/
    );
  });

  it('blocks private IPv4 unsubscribe URLs', async () => {
    await assert.rejects(
      () => validateUnsubscribeUrl('https://192.168.1.5/unsubscribe'),
      /Blocked unsafe unsubscribe URL host/
    );
  });

  it('blocks loopback IPv6 unsubscribe URLs', async () => {
    await assert.rejects(
      () => validateUnsubscribeUrl('http://[::1]/unsubscribe'),
      /Blocked unsafe unsubscribe URL host/
    );
  });

  it('blocks link-local IPv6 unsubscribe URLs', async () => {
    await assert.rejects(
      () => validateUnsubscribeUrl('http://[fe90::1]/unsubscribe'),
      /Blocked unsafe unsubscribe URL host/
    );
  });

  it('blocks IPv4-mapped loopback IPv6 unsubscribe URLs', async () => {
    await assert.rejects(
      () => validateUnsubscribeUrl('http://[::ffff:127.0.0.1]/unsubscribe'),
      /Blocked unsafe unsubscribe URL host/
    );
  });

  it('preserves form session cookies when submitting unsubscribe forms', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: url.toString(), opts });
      if (calls.length === 1) {
        return new Response(`
          <html>
            <body>
              <form action="/subscriptions/abc" method="post">
                <input type="hidden" name="authenticity_token" value="csrf-token">
                <input type="hidden" name="_method" value="delete">
                <button type="submit">Unsubscribe</button>
              </form>
            </body>
          </html>
        `, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': '_session=abc123; Path=/; HttpOnly',
          },
        });
      }
      return new Response('ok', { status: 200 });
    };

    try {
      const result = await followUnsubscribeLink('https://example.com/unsubscribe');

      assert.equal(result.status, 'succeeded');
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, 'https://example.com/subscriptions/abc');
      assert.equal(calls[1].opts.method, 'POST');
      assert.equal(calls[1].opts.headers.get('Cookie'), '_session=abc123');
      assert.equal(calls[1].opts.headers.get('Referer'), 'https://example.com/unsubscribe');
      assert.equal(calls[1].opts.headers.get('Origin'), 'https://example.com');
      assert.match(calls[1].opts.body, /authenticity_token=csrf-token/);
      assert.match(calls[1].opts.body, /_method=delete/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries one-click unsubscribe links with POST when GET is not allowed', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: url.toString(), opts });
      if (calls.length === 1) {
        return new Response('', { status: 405 });
      }
      return new Response('accepted', { status: 202 });
    };

    try {
      const result = await followUnsubscribeLink('https://example.com/list-unsubscribe');

      assert.equal(result.status, 'succeeded');
      assert.equal(result.method, 'one-click');
      assert.equal(result.note, 'POST List-Unsubscribe=One-Click returned HTTP 202');
      assert.equal(calls.length, 2);
      assert.equal(calls[0].opts.method, 'GET');
      assert.equal(calls[1].url, 'https://example.com/list-unsubscribe');
      assert.equal(calls[1].opts.method, 'POST');
      assert.equal(calls[1].opts.headers.get('Content-Type'), 'application/x-www-form-urlencoded');
      assert.equal(calls[1].opts.body, 'List-Unsubscribe=One-Click');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
