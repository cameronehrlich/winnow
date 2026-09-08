import { GogAdapter, normalizeGogMessage } from './adapters/gog.js';
import {
  assertReadableAttachment,
  collectThreadAttachments,
  MAX_ATTACHMENT_BYTES,
  normalizeAttachmentList,
  resolveFreshAttachment,
} from './email-attachments.js';
import { emailBodyToText } from './message-content.js';
import { discoverUnsubscribeMethods } from './unsubscribe-discovery.js';
import { embedInlineImages } from './email-inline-images.js';

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

function messageTimestamp(message) {
  const internalDate = Number(message?.internalDate);
  if (Number.isFinite(internalDate) && internalDate > 0) return internalDate;
  const parsed = Date.parse(String(message?.date || ''));
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function compareMessages(left, right) {
  const leftTimestamp = messageTimestamp(left.message);
  const rightTimestamp = messageTimestamp(right.message);
  if (leftTimestamp !== rightTimestamp) return leftTimestamp < rightTimestamp ? -1 : 1;
  const leftId = String(left.message?.id || left.message?.messageId || '');
  const rightId = String(right.message?.id || right.message?.messageId || '');
  const idDifference = leftId < rightId ? -1 : (leftId > rightId ? 1 : 0);
  return idDifference || left.index - right.index;
}

export function orderThreadMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => ({ message, index }))
    .sort(compareMessages)
    .map(entry => entry.message);
}

function deduplicateThreadMessages(messages) {
  const seen = new Set();
  return (Array.isArray(messages) ? messages : []).filter((message, index) => {
    const id = String(message?.id || message?.messageId || '');
    const key = id || `missing-id:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isDraftMessage(message) {
  return (Array.isArray(message?.labelIds) ? message.labelIds : []).includes('DRAFT');
}

function boundThreadMessages(messages, focusMessageId) {
  if (messages.length <= MAX_MESSAGES) return messages;
  const newest = messages.slice(-MAX_MESSAGES);
  if (!focusMessageId || newest.some(message => message.id === focusMessageId || message.messageId === focusMessageId)) {
    return newest;
  }
  const focused = messages.find(message => message.id === focusMessageId || message.messageId === focusMessageId);
  if (!focused) return newest;
  return orderThreadMessages([focused, ...newest.slice(-(MAX_MESSAGES - 1))]);
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
      if (exact.threadId !== item.threadId) {
        throw new Error('Gmail focus message does not belong to the requested thread');
      }
      if (exact.id || exact.body) messages = [exact, ...messages];
    }
  } else {
    messages = [normalizeGogMessage(await adapter.getMessage(item.account, item.messageId), { includeHtml: true })];
  }

  messages = orderThreadMessages(deduplicateThreadMessages(messages)).filter(message => !isDraftMessage(message));
  const wasMessageLimited = messages.length > MAX_MESSAGES;
  messages = boundThreadMessages(messages, item.messageId);
  const focusedSourceMessage = item.messageId
    ? messages.find(message => message?.id === item.messageId || message?.messageId === item.messageId)
    : messages.at(-1);
  const unsubscribeLink = focusedSourceMessage
    ? discoverUnsubscribeMethods(focusedSourceMessage).preferred?.url || ''
    : '';

  let budget = MAX_TOTAL_CHARS;
  let htmlBudget = MAX_TOTAL_HTML_CHARS;
  let truncated = false;
  const normalized = (Array.isArray(messages) ? messages : [])
    .map(message => {
      const labelIds = (Array.isArray(message?.labelIds) ? message.labelIds : [])
        .slice(0, 100)
        .map(label => bounded(label, 200));
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
        bcc: bounded(message?.bcc, 4_000),
        subject: bounded(message?.subject || item.subject, 2_000),
        date: bounded(message?.date, 200),
        internalDate: bounded(message?.internalDate, 64),
        labelIds,
        direction: labelIds.includes('SENT') && !labelIds.includes('DRAFT')
          ? 'sent'
          : 'received',
        snippet: bounded(message?.snippet, 10_000),
        attachments: normalizeAttachmentList(message?.attachments),
        body,
        htmlBody,
      };
    })
    .filter(message => message.id || message.body);

  if (!normalized.length) throw new Error('Gmail returned no readable messages for this thread');
  await embedInlineImages(normalized, messages, {
    account: item.account,
    focusedMessageId: item.messageId || normalized.at(-1)?.id,
    adapter,
  });
  const attachments = collectThreadAttachments({ messages });
  return {
    emailItemId: item.id,
    account: item.account,
    threadId: item.threadId || normalized[0].id,
    focusedMessageId: item.messageId || normalized.at(-1)?.id || '',
    subject: item.subject || normalized.find(message => message.id === (item.messageId || ''))?.subject
      || normalized.at(-1)?.subject || normalized[0].subject,
    messages: normalized,
    attachments,
    unsubscribeLink,
    truncated: truncated || budget === 0 || htmlBudget === 0 || wasMessageLimited,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchThreadContent({ account, threadId, focusMessageId = '' }, options = {}) {
  return fetchEmailContent({
    id: '',
    account,
    threadId,
    messageId: focusMessageId,
    subject: '',
  }, options);
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
