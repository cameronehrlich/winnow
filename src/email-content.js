import { GogAdapter, normalizeGogMessage } from './adapters/gog.js';
import {
  assertReadableAttachment,
  collectThreadAttachments,
  MAX_ATTACHMENT_BYTES,
  resolveFreshAttachment,
} from './email-attachments.js';
import { emailBodyToText } from './message-content.js';

const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_TOTAL_CHARS = 200_000;
const MAX_HTML_MESSAGE_CHARS = 500_000;
const MAX_TOTAL_HTML_CHARS = 1_500_000;

function bounded(value, max) {
  return String(value || '').slice(0, Math.max(0, max));
}

function displayBody(message, budget) {
  const source = String(message?.body || message?.snippet || '');
  const limit = Math.min(MAX_MESSAGE_CHARS, budget);
  const raw = bounded(source, limit);
  const body = bounded(emailBodyToText(raw), limit);
  return { body, truncated: source.length > raw.length };
}

function displayHtmlBody(message, budget) {
  const source = String(message?.htmlBody || '');
  const limit = Math.min(MAX_HTML_MESSAGE_CHARS, budget);
  const htmlBody = bounded(source, limit);
  return { htmlBody, truncated: source.length > htmlBody.length };
}

export async function fetchEmailContent(item, { adapter = new GogAdapter() } = {}) {
  if (!item?.account || (!item.threadId && !item.messageId)) {
    throw new TypeError('Email account and Gmail identifier are required');
  }

  let messages;
  if (item.threadId) {
    const thread = await adapter.getThread(item.account, item.threadId, { includeHtml: true });
    messages = Array.isArray(thread?.messages) ? thread.messages : [];
    if (item.messageId && !messages.some(message => message?.id === item.messageId || message?.messageId === item.messageId)) {
      const exact = normalizeGogMessage(await adapter.getMessage(item.account, item.messageId), { includeHtml: true });
      if (exact.id || exact.body) messages = [exact, ...messages];
    }
  } else {
    messages = [normalizeGogMessage(await adapter.getMessage(item.account, item.messageId), { includeHtml: true })];
  }

  let budget = MAX_TOTAL_CHARS;
  let htmlBudget = MAX_TOTAL_HTML_CHARS;
  let truncated = false;
  const normalized = (Array.isArray(messages) ? messages : [])
    .slice(0, MAX_MESSAGES)
    .map(message => {
      const displayed = displayBody(message, budget);
      const displayedHtml = displayHtmlBody(message, htmlBudget);
      const body = displayed.body;
      const htmlBody = displayedHtml.htmlBody;
      truncated ||= displayed.truncated || displayedHtml.truncated;
      budget = Math.max(0, budget - body.length);
      htmlBudget = Math.max(0, htmlBudget - htmlBody.length);
      return {
        id: bounded(message?.id || message?.messageId, 256),
        from: bounded(message?.from, 2_000),
        to: bounded(message?.to, 4_000),
        cc: bounded(message?.cc, 4_000),
        subject: bounded(message?.subject || item.subject, 2_000),
        date: bounded(message?.date, 200),
        body,
        htmlBody,
      };
    })
    .filter(message => message.id || message.body);

  if (!normalized.length) throw new Error('Gmail returned no readable messages for this thread');
  const attachments = collectThreadAttachments({ messages });
  return {
    emailItemId: item.id,
    account: item.account,
    threadId: item.threadId || normalized[0].id,
    focusedMessageId: item.messageId || normalized.at(-1)?.id || '',
    subject: item.subject || normalized[0].subject,
    messages: normalized,
    attachments,
    truncated: truncated || budget === 0 || htmlBudget === 0 || messages.length > MAX_MESSAGES,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchEmailAttachments(item, { adapter = new GogAdapter() } = {}) {
  if (!item?.account || (!item.threadId && !item.messageId)) {
    throw new TypeError('Email account and Gmail identifier are required');
  }
  const messages = item.threadId
    ? (await adapter.getThread(item.account, item.threadId))?.messages || []
    : [normalizeGogMessage(await adapter.getMessage(item.account, item.messageId))];
  return collectThreadAttachments({ messages });
}

export async function fetchEmailAttachment(item, attachmentId, { adapter = new GogAdapter() } = {}) {
  const attachments = await fetchEmailAttachments(item, { adapter });
  const attachment = assertReadableAttachment(resolveFreshAttachment(
    { attachmentId },
    item.attachments,
    attachments,
  ));
  const data = await adapter.getAttachment(
    item.account,
    attachment.messageId,
    attachment.attachmentId,
    { maxBytes: Math.min(attachment.sizeBytes, MAX_ATTACHMENT_BYTES) },
  );
  if (!Buffer.isBuffer(data) || data.length > MAX_ATTACHMENT_BYTES || data.length > attachment.sizeBytes) {
    const error = new Error('attachment_size_not_supported');
    error.code = 'attachment_size_not_supported';
    throw error;
  }
  return { attachment, data };
}
