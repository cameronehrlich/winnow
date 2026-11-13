import { GogAdapter, normalizeGogMessage } from './adapters/gog.js';
import { emailBodyCache } from './email-body-cache.js';
import { embedInlineImages } from './email-inline-images.js';
import { discoverUnsubscribeMethods } from './unsubscribe-discovery.js';
import { emailBodyToText } from './message-content.js';

export async function fetchReaderContent(item, {
  adapter = new GogAdapter(), cache = emailBodyCache, images = false, refresh = false,
} = {}) {
  if (!item.account || !item.messageId) throw new Error('Exact email identity required');
  const missingKey = cache.key(item.account, item.messageId, 'missing');
  const unavailable = () => Object.assign(new Error('Email not found'), { status: 404 });
  if (await cache.read(missingKey)) throw unavailable();
  const sourceKey = cache.key(item.account, item.messageId);
  const imagesKey = cache.key(item.account, item.messageId, 'images');
  if (refresh) await cache.remove(imagesKey);
  const source = await cache.getOrLoad(sourceKey, async () => {
    let raw;
    try { raw = await adapter.getMessage(item.account, item.messageId); }
    catch (error) {
      if (/(?:\b404\b|notFound|requested entity was not found)/i.test(String(error?.stderr || error?.message || ''))) {
        await cache.markMissing(item.account, item.messageId);
        throw unavailable();
      }
      throw error;
    }
    const message = normalizeGogMessage(raw, { includeHtml: true });
    if (message.id !== item.messageId || (item.threadId && message.threadId !== item.threadId)
      || message.labelIds.includes('DRAFT')) throw new Error('Gmail returned an unexpected message');
    return message;
  }, { refresh });
  if (source.id !== item.messageId || (item.threadId && source.threadId !== item.threadId)
    || !Array.isArray(source.labelIds) || source.labelIds.includes('DRAFT')) {
    await cache.remove(sourceKey);
    await cache.remove(imagesKey);
    throw new Error('Invalid cached message identity');
  }
  const hasInlineImages = /\bcid:/i.test(source.htmlBody) && source.inlineImages?.length > 0;
  let message = { ...source, body: emailBodyToText(source.body) };
  if (images && hasInlineImages) {
    message = await cache.getOrLoad(imagesKey, async () => {
      const hydrated = { ...message };
      await embedInlineImages([hydrated], [source], {
        account: item.account, focusedMessageId: item.messageId, adapter,
      });
      return hydrated;
    }, { refresh });
    // A temporary attachment failure must be retryable, not cached for a day.
    if (/\bcid:/i.test(message.htmlBody)) await cache.remove(imagesKey);
  }
  // Never expose raw provider headers/resources or use cached labels to update
  // mailbox state. The accompanying item is read freshly from SQLite by the API.
  const { inlineImages, headers, ...displayed } = message;
  if (await cache.read(missingKey)) throw unavailable();
  return {
    emailItemId: item.id, account: item.account, threadId: source.threadId,
    focusedMessageId: item.messageId, subject: source.subject,
    messages: [displayed], attachments: source.attachments,
    unsubscribeLink: discoverUnsubscribeMethods(source).preferred?.url || '',
    readerMode: 'message', inlineImagesLoaded: !hasInlineImages || (images && !/\bcid:/i.test(message.htmlBody)),
    truncated: source.body.length >= 100_000 || source.htmlBody.length >= 500_000,
    fetchedAt: new Date().toISOString(),
  };
}
