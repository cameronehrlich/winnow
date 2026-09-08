// Resolve MIME Content-ID images locally. Never fetch URLs supplied by email HTML.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 20;
const CID_URL = /\bcid:([^\s"'<>()[\]]+)/gi;

function contentId(value) {
  const text = String(value || '').trim();
  try {
    return decodeURIComponent(text).replace(/^<|>$/g, '');
  } catch {
    return text.replace(/^<|>$/g, '');
  }
}

export function collectInlineImages(message) {
  const images = [];
  let visited = 0;
  let embeddedBytes = 0;
  function visit(part, depth = 0) {
    if (!part || depth > 20 || visited++ >= 500 || images.length >= 50) return;
    const header = (Array.isArray(part.headers) ? part.headers : [])
      .find(header => String(header?.name).toLowerCase() === 'content-id');
    const id = contentId(header?.value);
    const mimeType = String(part.mimeType || '').toLowerCase().split(';')[0].trim();
    const sizeBytes = Number(part.body?.size);
    if (id && id.length <= 2048 && IMAGE_TYPES.has(mimeType)
      && Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= MAX_IMAGE_BYTES) {
      if (part.body?.attachmentId) {
        images.push({ contentId: id, mimeType, sizeBytes, attachmentId: part.body.attachmentId });
      } else if (typeof part.body?.data === 'string'
        && part.body.data.length <= Math.ceil(sizeBytes / 3) * 4
        && embeddedBytes + sizeBytes <= MAX_TOTAL_BYTES) {
        embeddedBytes += sizeBytes;
        images.push({ contentId: id, mimeType, sizeBytes, data: part.body.data });
      }
    }
    for (const child of Array.isArray(part.parts) ? part.parts : []) visit(child, depth + 1);
  }
  visit(message?.payload);
  return images;
}

export async function embedInlineImages(messages, sources, {
  account, focusedMessageId, adapter, signal = AbortSignal.timeout(10_000),
}) {
  let remainingBytes = MAX_TOTAL_BYTES;
  let remainingImages = MAX_IMAGES;
  const sourceById = new Map(sources.map(message => [message.id || message.messageId, message]));
  // The displayed message gets first use of the budget, even in a long thread.
  const ordered = [...messages].sort((a, b) => Number(b.id === focusedMessageId) - Number(a.id === focusedMessageId));
  for (const message of ordered) {
    if (signal.aborted) break;
    if (!message.htmlBody || remainingImages <= 0) continue;
    const references = new Map();
    for (const match of message.htmlBody.matchAll(CID_URL)) {
      const id = contentId(match[1]);
      references.set(id, (references.get(id) || 0) + 1);
    }
    if (!references.size) continue;
    const resources = sourceById.get(message.id)?.inlineImages || [];
    const selected = [];
    const seen = new Set();
    for (const resource of resources) {
      const count = references.get(resource.contentId);
      const size = resource.sizeBytes;
      if (!count || seen.has(resource.contentId) || !IMAGE_TYPES.has(resource.mimeType)
        || !Number.isSafeInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES
        || size * count > remainingBytes || remainingImages <= 0) continue;
      seen.add(resource.contentId);
      remainingBytes -= size * count;
      remainingImages -= 1;
      selected.push(resource);
    }
    const resolved = new Map();
    // Small bounded batches avoid serial attachment latency and unbounded fan-out.
    for (let offset = 0; offset < selected.length; offset += 4) {
      if (signal.aborted) break;
      await Promise.all(selected.slice(offset, offset + 4).map(async resource => {
        try {
          const data = resource.attachmentId
            ? await adapter.getAttachment(account, message.id, resource.attachmentId, { maxBytes: resource.sizeBytes, signal })
            : Buffer.from(resource.data || '', 'base64url');
          if (!Buffer.isBuffer(data) || !data.length || data.length > resource.sizeBytes) return;
          resolved.set(resource.contentId, `data:${resource.mimeType};base64,${data.toString('base64')}`);
        } catch {
          // An unavailable picture must not prevent reading the email. The
          // original attachment remains available for a separate retry.
        }
      }));
    }
    message.htmlBody = message.htmlBody.replace(CID_URL, (url, id) => resolved.get(contentId(id)) || url);
  }
}
