import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discoverUnsubscribeMethods } from '../src/unsubscribe-discovery.js';

describe('unsubscribe discovery', () => {
  it('prefers deterministic List-Unsubscribe HTTP methods and marks one-click', () => {
    const result = discoverUnsubscribeMethods({
      headers: {
        'List-Unsubscribe': '<mailto:leave@example.com>, <https://example.com/u?id=123>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    assert.deepEqual(result.methods, [
      { type: 'http', url: 'https://example.com/u?id=123', source: 'header', oneClick: true },
      { type: 'mailto', url: 'mailto:leave@example.com', source: 'header', oneClick: false },
    ]);
    assert.equal(result.preferred.url, 'https://example.com/u?id=123');
  });

  it('extracts only semantically labeled unsubscribe links from HTML', () => {
    const result = discoverUnsubscribeMethods({
      body: `
        <a href="https://example.com/order/123">View order</a>
        <a class="footer-unsubscribe" href="https://example.com/leave?a=1&amp;b=2">Manage email preferences</a>
      `,
    });
    assert.deepEqual(result.methods, [
      { type: 'http', url: 'https://example.com/leave?a=1&b=2', source: 'body', oneClick: false },
    ]);
  });

  it('extracts URLs only from plain-text lines with unsubscribe language', () => {
    const result = discoverUnsubscribeMethods({ body: `
      Receipt: https://example.com/order/123
      To unsubscribe, visit https://example.com/unsubscribe/abc.
    ` });
    assert.equal(result.methods.length, 1);
    assert.equal(result.methods[0].url, 'https://example.com/unsubscribe/abc');
  });

  it('rejects unsupported schemes, malformed mailto values, and invented links', () => {
    const result = discoverUnsubscribeMethods({
      headers: { 'list-unsubscribe': '<javascript:alert(1)>, <mailto:not-an-address>' },
      body: '<p>You may unsubscribe at any time.</p><a href="https://example.com/account">Account</a>',
    });
    assert.deepEqual(result, { methods: [], preferred: null });
  });

  it('deduplicates header and body copies while keeping header provenance', () => {
    const result = discoverUnsubscribeMethods({
      unsubscribe: 'https://example.com/leave',
      body: '<a href="https://example.com/leave">Unsubscribe</a>',
    });
    assert.equal(result.methods.length, 1);
    assert.equal(result.methods[0].source, 'header');
  });

  it('discovers explicitly labeled links from bounded MIME HTML parts', () => {
    const html = '<a href="https://example.com/mime-leave">Unsubscribe</a>';
    const result = discoverUnsubscribeMethods({
      payload: {
        mimeType: 'multipart/alternative',
        parts: [{ mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } }],
      },
    });
    assert.equal(result.preferred.url, 'https://example.com/mime-leave');
    assert.equal(result.preferred.source, 'body');
  });

  it('uses the full MIME body when a normalized top-level body is only a stub', () => {
    const html = '<a href="https://example.com/full-message-leave">Unsubscribe</a>';
    const result = discoverUnsubscribeMethods({
      body: 'stub',
      unsubscribe: 'mailto:leave@example.com',
      message: {
        payload: {
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } }],
        },
      },
    });

    assert.equal(result.preferred.url, 'https://example.com/full-message-leave');
    assert.deepEqual(result.methods.map(method => method.type), ['http', 'mailto']);
  });
});
