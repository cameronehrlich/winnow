import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectInlineImages, embedInlineImages } from '../src/email-inline-images.js';
import { normalizeGogMessage } from '../src/adapters/gog.js';
import { fetchEmailContent, fetchThreadContent } from '../src/email-content.js';

const image = (contentId = 'scan.jpg', extra = {}) => ({
  mimeType: 'image/jpeg',
  headers: [{ name: 'Content-Id', value: `<${contentId}>` }],
  body: { attachmentId: 'a1', size: 3 },
  ...extra,
});

function message(id = 'm1', parts = [image()]) {
  return normalizeGogMessage({
    id, threadId: 't1', htmlBody: '<img src="cid:scan.jpg">',
    payload: { parts },
  }, { includeHtml: true });
}

describe('inline MIME images', () => {
  it('preserves Content-ID resources through exact-message wrappers and nested MIME parts', () => {
    const normalized = normalizeGogMessage({ message: {
      id: 'm1', payload: { parts: [{ parts: [image()] }] },
    } }, { includeHtml: true });
    assert.deepEqual(normalized.inlineImages, [{
      contentId: 'scan.jpg', mimeType: 'image/jpeg', sizeBytes: 3, attachmentId: 'a1',
    }]);
    assert.equal(normalizeGogMessage({ payload: { parts: [image()] } }).inlineImages, undefined);
  });

  it('renders attachment images in both email and thread content without downloading unrelated files', async () => {
    for (const fetch of [fetchEmailContent, fetchThreadContent]) {
      const source = message();
      source.htmlBody = '<img src="CID:scan%2Ejpg"><img src=cid:scan.jpg><img src="https://tracker.example/pixel">';
      source.inlineImages.push({ contentId: 'unused', mimeType: 'image/png', sizeBytes: 3, attachmentId: 'unused' });
      const calls = [];
      const result = await fetch({ account: 'me@example.com', threadId: 't1', messageId: 'm1', focusMessageId: 'm1' }, {
        adapter: {
          getThread: async () => ({ messages: [source] }),
          getAttachment: async (...args) => { calls.push(args); return Buffer.from('jpg'); },
        },
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].slice(0, 3), ['me@example.com', 'm1', 'a1']);
      assert.equal(calls[0][3].maxBytes, 3);
      assert.ok(calls[0][3].signal instanceof AbortSignal);
      assert.equal(result.messages[0].htmlBody,
        '<img src="data:image/jpeg;base64,anBn"><img src=data:image/jpeg;base64,anBn><img src="https://tracker.example/pixel">');
      assert.equal(result.messages[0].inlineImages, undefined, 'do not expose raw MIME resources in API');
    }
  });

  it('keeps reused Content-IDs scoped to the exact message', async () => {
    const sources = [message('m1'), message('m2')];
    const displayed = sources.map(source => ({ id: source.id, htmlBody: source.htmlBody }));
    await embedInlineImages(displayed, sources, {
      account: 'me@example.com', adapter: { getAttachment: async (account, id) => Buffer.from(id) },
    });
    assert.match(displayed[0].htmlBody, /bTE=/);
    assert.match(displayed[1].htmlBody, /bTI=/);
  });

  it('supports small MIME images carried directly in the Gmail payload', async () => {
    const source = message('m1', [image('scan.jpg', { body: { size: 3, data: 'anBn' } })]);
    const displayed = [{ id: source.id, htmlBody: source.htmlBody }];
    await embedInlineImages(displayed, [source], { account: 'me@example.com', adapter: {} });
    assert.match(displayed[0].htmlBody, /data:image\/jpeg;base64,anBn/);
  });

  it('leaves the email readable when downloads fail, exceed metadata, or lack a matching CID', async () => {
    for (const getAttachment of [
      async () => { throw new Error('unavailable'); },
      async () => Buffer.alloc(4),
      async () => Buffer.alloc(0),
    ]) {
      const source = message();
      const displayed = [{ id: source.id, htmlBody: source.htmlBody + '<img src="cid:missing">' }];
      await embedInlineImages(displayed, [source], { account: 'me@example.com', adapter: { getAttachment } });
      assert.equal(displayed[0].htmlBody, source.htmlBody + '<img src="cid:missing">');
    }
  });

  it('rejects active formats, oversized images, and missing Content-IDs', () => {
    assert.deepEqual(collectInlineImages({ payload: { parts: [
      image('svg', { mimeType: 'image/svg+xml' }),
      image('html', { mimeType: 'text/html' }),
      image('big', { body: { attachmentId: 'big', size: 6 * 1024 * 1024 } }),
      image('missing', { headers: [] }),
      image('invalid', { body: { attachmentId: 'bad', size: -1 } }),
    ] } }), []);
  });

  it('bounds expanded bytes including repeated references, with focus priority', async () => {
    const sources = [message('old'), message('focus')];
    for (const source of sources) source.inlineImages[0].sizeBytes = 5 * 1024 * 1024;
    const displayed = sources.map(source => ({ id: source.id, htmlBody: source.htmlBody.repeat(2) }));
    const calls = [];
    await embedInlineImages(displayed, sources, {
      account: 'me@example.com', focusedMessageId: 'focus',
      adapter: { getAttachment: async (account, id) => { calls.push(id); return Buffer.from('jpg'); } },
    });
    assert.deepEqual(calls, ['focus']);
    assert.match(displayed[0].htmlBody, /cid:/);
    assert.doesNotMatch(displayed[1].htmlBody, /cid:/);
  });

  it('bounds image count and concurrent downloads', async () => {
    const source = message('m1', Array.from({ length: 30 }, (_, i) => image(`scan-${i}`)));
    source.htmlBody = source.inlineImages.map(resource => `<img src="cid:${resource.contentId}">`).join('');
    let active = 0, peak = 0, count = 0;
    const displayed = [{ id: source.id, htmlBody: source.htmlBody }];
    await embedInlineImages(displayed, [source], {
      account: 'me@example.com', adapter: { getAttachment: async () => {
        count += 1;
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        return Buffer.from('jpg');
      } },
    });
    assert.equal(count, 20);
    assert.ok(peak <= 4);
    assert.equal([...displayed[0].htmlBody.matchAll(/data:image/g)].length, 20);
  });

  it('cancels slow downloads and does not start more after the rendering deadline', async () => {
    const source = message('m1', Array.from({ length: 8 }, (_, i) => image(`scan-${i}`)));
    source.htmlBody = source.inlineImages.map(resource => `<img src="cid:${resource.contentId}">`).join('');
    const controller = new AbortController();
    let calls = 0;
    const displayed = [{ id: source.id, htmlBody: source.htmlBody }];
    const operation = embedInlineImages(displayed, [source], {
      account: 'me@example.com', signal: controller.signal,
      adapter: { getAttachment: async (account, id, attachmentId, { signal }) => {
        calls += 1;
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      } },
    });
    controller.abort();
    await operation;
    assert.equal(calls, 4);
    assert.equal(displayed[0].htmlBody, source.htmlBody);
  });
});
