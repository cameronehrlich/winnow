import { GogAdapter, normalizeGogMessage } from './adapters/gog.js';
import { emailBodyToText } from './message-content.js';

const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_TOTAL_CHARS = 200_000;

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

export async function fetchEmailContent(item, { adapter = new GogAdapter() } = {}) {
  if (!item?.account || (!item.threadId && !item.messageId)) {
    throw new TypeError('Email account and Gmail identifier are required');
  }

  let messages;
  if (item.threadId) {
    const thread = await adapter.getThread(item.account, item.threadId);
    messages = Array.isArray(thread?.messages) ? thread.messages : [];
    if (item.messageId && !messages.some(message => message?.id === item.messageId || message?.messageId === item.messageId)) {
      const exact = normalizeGogMessage(await adapter.getMessage(item.account, item.messageId));
      if (exact.id || exact.body) messages = [exact, ...messages];
    }
  } else {
    messages = [normalizeGogMessage(await adapter.getMessage(item.account, item.messageId))];
  }

  let budget = MAX_TOTAL_CHARS;
  let truncated = false;
  const normalized = (Array.isArray(messages) ? messages : [])
    .slice(0, MAX_MESSAGES)
    .map(message => {
      const displayed = displayBody(message, budget);
      const body = displayed.body;
      truncated ||= displayed.truncated;
      budget = Math.max(0, budget - body.length);
      return {
        id: bounded(message?.id || message?.messageId, 256),
        from: bounded(message?.from, 2_000),
        to: bounded(message?.to, 4_000),
        cc: bounded(message?.cc, 4_000),
        subject: bounded(message?.subject || item.subject, 2_000),
        date: bounded(message?.date, 200),
        body,
      };
    })
    .filter(message => message.id || message.body);

  if (!normalized.length) throw new Error('Gmail returned no readable messages for this thread');
  return {
    emailItemId: item.id,
    account: item.account,
    threadId: item.threadId || normalized[0].id,
    focusedMessageId: item.messageId || normalized.at(-1)?.id || '',
    subject: item.subject || normalized[0].subject,
    messages: normalized,
    truncated: truncated || budget === 0 || messages.length > MAX_MESSAGES,
    fetchedAt: new Date().toISOString(),
  };
}
