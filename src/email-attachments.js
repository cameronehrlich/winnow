export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 50;

const SUPPORTED_ATTACHMENT_TYPES = new Set(['application/pdf']);

function boundedString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

export function normalizeAttachmentMetadata(value, fallbackMessageId = '') {
  const attachmentId = boundedString(value?.attachmentId || value?.id, 2048);
  const messageId = boundedString(value?.messageId || fallbackMessageId, 256);
  if (!attachmentId || !messageId) return null;

  const rawSize = Number(value?.sizeBytes ?? value?.size ?? value?.body?.size);
  const sizeBytes = Number.isSafeInteger(rawSize) && rawSize >= 0 ? rawSize : 0;
  return {
    messageId,
    attachmentId,
    filename: boundedString(value?.filename || value?.name || 'Attachment', 500),
    mimeType: boundedString(value?.mimeType || value?.contentType || 'application/octet-stream', 200)
      .toLowerCase(),
    sizeBytes,
  };
}

export function normalizeAttachmentList(values, { fallbackMessageId = '', limit = MAX_ATTACHMENTS } = {}) {
  const normalized = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const attachment = normalizeAttachmentMetadata(value, fallbackMessageId);
    if (!attachment) continue;
    const key = `${attachment.messageId}\0${attachment.attachmentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(attachment);
    if (normalized.length >= limit) break;
  }
  return normalized;
}

export function collectMessageAttachments(message, { limit = MAX_ATTACHMENTS } = {}) {
  const value = message?.message && typeof message.message === 'object'
    ? { ...message, ...message.message }
    : message;
  const messageId = boundedString(value?.id || value?.Id || value?.messageId, 256);
  const found = [];
  let visited = 0;

  function visit(part, depth = 0) {
    if (!part || typeof part !== 'object' || depth > 20 || visited >= 500 || found.length >= limit) return;
    visited += 1;
    const attachmentId = part?.body?.attachmentId || part?.attachmentId;
    if (attachmentId) {
      const normalized = normalizeAttachmentMetadata({
        messageId,
        attachmentId,
        filename: part.filename,
        mimeType: part.mimeType,
        sizeBytes: part?.body?.size ?? part?.size,
      });
      if (normalized) found.push(normalized);
    }
    for (const child of Array.isArray(part.parts) ? part.parts : []) visit(child, depth + 1);
  }

  visit(value?.payload);
  return normalizeAttachmentList([
    ...(Array.isArray(value?.attachments) ? value.attachments : []),
    ...found,
  ], { fallbackMessageId: messageId, limit });
}

export function collectThreadAttachments(thread, { limit = MAX_ATTACHMENTS } = {}) {
  const attachments = [];
  for (const message of Array.isArray(thread?.messages) ? thread.messages : []) {
    attachments.push(...normalizeAttachmentList(message?.attachments, {
      fallbackMessageId: message?.messageId || message?.id || '',
      limit: limit - attachments.length,
    }));
    if (attachments.length >= limit) break;
  }
  return normalizeAttachmentList(attachments, { limit });
}

export function assertReadableAttachment(attachment) {
  const normalized = normalizeAttachmentMetadata(attachment);
  if (!normalized) {
    const error = new Error('attachment_not_found');
    error.code = 'attachment_not_found';
    throw error;
  }
  if (!SUPPORTED_ATTACHMENT_TYPES.has(normalized.mimeType)) {
    const error = new Error('attachment_type_not_supported');
    error.code = 'attachment_type_not_supported';
    throw error;
  }
  if (!normalized.sizeBytes || normalized.sizeBytes > MAX_ATTACHMENT_BYTES) {
    const error = new Error('attachment_size_not_supported');
    error.code = 'attachment_size_not_supported';
    throw error;
  }
  return normalized;
}
