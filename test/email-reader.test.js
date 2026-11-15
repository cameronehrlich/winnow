import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmailBodyCache } from '../src/email-body-cache.js';
import { fetchReaderContent } from '../src/email-reader.js';

const item = { id: 'local-1', account: 'a@example.com', messageId: 'm1', threadId: 't1' };
function raw(body = 'Hello') {
  return { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], body,
    payload: { mimeType: 'multipart/related', headers: [], parts: [
      { mimeType: 'text/html', body: { data: Buffer.from('<p>Hello</p><img src="cid:picture">').toString('base64url') } },
      { mimeType: 'image/png', headers: [{ name: 'Content-ID', value: '<picture>' }], body: { size: 3, attachmentId: 'image1' } },
    ] } };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'winnow-reader-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new EmailBodyCache({ directory, ...options });
}

it('returns exact text without fetching a thread or waiting for inline pictures', async t => {
  const cache = await fixture(t);
  let reads = 0, images = 0;
  const adapter = { getMessage: async () => { reads++; return raw(); },
    getAttachment: async () => { images++; return Buffer.from('png'); },
    getThread: async () => { throw Error('must not load thread'); } };
  const first = await fetchReaderContent(item, { cache, adapter });
  assert.equal(first.messages.length, 1);
  assert.equal(first.readerMode, 'message');
  assert.equal(first.inlineImagesLoaded, false);
  assert.equal(images, 0);
  assert.equal(first.messages[0].inlineImages, undefined);
  assert.equal(first.messages[0].headers, undefined);
  const illustrated = await fetchReaderContent(item, { cache, adapter, images: true });
  assert.match(illustrated.messages[0].htmlBody, /data:image\/png;base64,cG5n/);
  assert.equal(illustrated.inlineImagesLoaded, true);
  assert.equal(reads, 1);
  assert.equal(images, 1);
  await fetchReaderContent(item, { cache, adapter, images: true });
  assert.equal(images, 1);
  // Disk cache survives a new process/cache object.
  await fetchReaderContent(item, { cache: new EmailBodyCache({ directory: cache.directory }), adapter });
  assert.equal(reads, 1);
});

it('coalesces loads, isolates account identities, and bypasses stale bodies on refresh', async t => {
  const cache = await fixture(t);
  let reads = 0;
  const adapter = { getMessage: async () => { reads++; return raw(`version ${reads}`); } };
  await Promise.all(Array.from({ length: 5 }, () => fetchReaderContent(item, { cache, adapter })));
  assert.equal(reads, 1);
  await fetchReaderContent({ ...item, account: 'b@example.com' }, { cache, adapter });
  assert.equal(reads, 2);
  const refreshed = await fetchReaderContent(item, { cache, adapter, refresh: true });
  assert.equal(reads, 3);
  assert.equal(refreshed.messages[0].body, 'version 3');
});

it('does not permanently cache failed inline downloads', async t => {
  const cache = await fixture(t);
  let succeeds = false;
  const adapter = { getMessage: async () => raw(), getAttachment: async () => {
    if (!succeeds) throw Error('temporary outage'); return Buffer.from('png');
  } };
  assert.equal((await fetchReaderContent(item, { cache, adapter, images: true })).inlineImagesLoaded, false);
  succeeds = true;
  assert.equal((await fetchReaderContent(item, { cache, adapter, images: true })).inlineImagesLoaded, true);
});

it('retains supported illustrations even when the HTML also references a missing CID', async t => {
  const cache = await fixture(t);
  const message = { ...raw(), htmlBody: '<img src="cid:picture"><img src="cid:unknown">' };
  let reads = 0;
  const adapter = { getMessage: async () => message, getAttachment: async () => { reads++; return Buffer.from('png'); } };
  for (let i = 0; i < 2; i++) {
    const response = await fetchReaderContent(item, { cache, adapter, images: true });
    assert.ok(response.inlineImagesLoaded);
    assert.match(response.messages[0].htmlBody, /data:image\/png/);
  }
  const illustration = await cache.read(cache.key(item.account, item.messageId, 'images'));
  assert.deepEqual(Object.keys(illustration).sort(), ['complete', 'htmlBody']);
  assert.equal(reads, 1);
});

it('an explicit refresh never joins a concurrent disk hit', async t => {
  const cache = await fixture(t);
  const key = cache.key('a', 'm');
  await cache.write(key, { version: 1 });
  const loader = async () => ({ version: 2 });
  const normal = cache.getOrLoad(key, loader);
  assert.deepEqual(await cache.getOrLoad(key, loader, { refresh: true }), { version: 2 });
  await normal;
  assert.deepEqual(await cache.read(key), { version: 2 });
});

it('rejects mismatched provider identities and draft content', async t => {
  const cache = await fixture(t);
  for (const message of [{ ...raw(), id: 'wrong' }, { ...raw(), threadId: 'wrong' }, { ...raw(), labelIds: ['DRAFT'] }]) {
    await assert.rejects(fetchReaderContent(item, { cache, adapter: { getMessage: async () => message } }));
  }
  assert.equal((await readdir(cache.directory)).length, 0);
});

it('bounds disk storage, expires content, and recovers corrupt cache entries', async t => {
  let time = Date.now();
  const cache = await fixture(t, { maxEntries: 2, maxBytes: 2048, ttlMs: 1000, now: () => time });
  const keys = [1, 2, 3].map(id => cache.key('a', String(id)));
  for (const key of keys) await cache.write(key, { body: 'hello' });
  assert.equal((await readdir(cache.directory)).length, 2);
  const key = cache.key('a', 'corrupt');
  await writeFile(join(cache.directory, `${key}.json`), 'not json');
  assert.equal(await cache.read(key), null);
  assert.deepEqual(await cache.getOrLoad(key, async () => ({ repaired: true })), { repaired: true });
  time += 1001;
  assert.equal(await cache.read(key), null);
  await cache.write(cache.key('a', 'oversized'), { body: 'x'.repeat(3000) });
  assert.equal(await cache.read(cache.key('a', 'oversized')), null);
});

it('does not resurrect bodies after Gmail deletion, including an in-flight image fetch', async t => {
  const cache = await fixture(t);
  let release;
  let started;
  const downloading = new Promise(resolve => { started = resolve; });
  const adapter = { getMessage: async () => raw(), getAttachment: async () => {
    started(); await new Promise(resolve => { release = resolve; }); return Buffer.from('png');
  } };
  const pending = fetchReaderContent(item, { cache, adapter, images: true });
  await downloading;
  await cache.markMissing(item.account, item.messageId);
  release();
  await assert.rejects(pending, { status: 404 });
  assert.equal(await cache.read(cache.key(item.account, item.messageId, 'images')), null);
  await assert.rejects(fetchReaderContent(item, { cache, adapter }), { status: 404 });
});

it('maps provider missing messages to a cached tombstone, not a generic transport error', async t => {
  const cache = await fixture(t);
  let reads = 0;
  const adapter = { getMessage: async () => { reads++; throw Error('404 notFound'); } };
  await assert.rejects(fetchReaderContent(item, { cache, adapter }), { status: 404 });
  await assert.rejects(fetchReaderContent(item, { cache, adapter }), { status: 404 });
  assert.equal(reads, 1);
});
