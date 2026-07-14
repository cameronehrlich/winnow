import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GmailAdapter } from './gmail.js';
import { normalizeEmailHeaderText } from '../email-metadata.js';
import { collectMessageAttachments, MAX_ATTACHMENT_BYTES } from '../email-attachments.js';

const defaultExecute = promisify(execFile);
const GOG_FLAGS = ['--json', '--no-input'];
const EXEC_OPTIONS = {
  timeout: 30000,
  maxBuffer: 10 * 1024 * 1024,
};
const MAX_QUERY_LENGTH = 4096;
const MAX_BODY_LENGTH = 100_000;
const MAX_HTML_BODY_LENGTH = 500_000;
const MAX_NOTE_LENGTH = 20_000;
const MAX_THREAD_MESSAGES = 100;
const MAX_THREAD_BODY_LENGTH = 500_000;
const MAX_THREAD_HTML_BODY_LENGTH = 1_500_000;
const MAX_RECIPIENTS = 50;
const MAX_SYNC_RESULTS = 500;

function parseJson(stdout) {
  try {
    return JSON.parse(String(stdout || ''));
  } catch {
    // gog output can contain complete message bodies. Never echo malformed
    // output into logs, where private mail content could be retained.
    console.error('[winnow] Failed to parse gog JSON output');
    return null;
  }
}

function requireString(value, name, maxLength, { pattern = null, allowEmpty = false, preserve = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new TypeError(`${name} is required`);
  if (value.length > maxLength) throw new RangeError(`${name} exceeds ${maxLength} characters`);
  if (/\0/.test(value)) throw new TypeError(`${name} must not contain null bytes`);
  if (/[\r\n]/.test(normalized) && name !== 'body' && name !== 'note') {
    throw new TypeError(`${name} must not contain line breaks`);
  }
  if (pattern && !pattern.test(normalized)) throw new TypeError(`${name} is invalid`);
  return preserve ? value : normalized;
}

function validateAccount(account) {
  return requireString(account, 'account', 320, {
    pattern: /^[^\s@,<>]+@[^\s@,<>]+$/,
  });
}

function validateGmailId(value, name) {
  return requireString(value, name, 256, { pattern: /^[A-Za-z0-9_-]+$/ });
}

function validateAttachmentId(value) {
  return requireString(value, 'attachmentId', 2048, { pattern: /^[A-Za-z0-9_-]+$/ });
}

function normalizeRecipientList(value, name, { required = false } = {}) {
  const input = value == null ? [] : (Array.isArray(value) ? value : [value]);
  if (required && input.length === 0) throw new TypeError(`${name} requires at least one recipient`);
  if (input.length > MAX_RECIPIENTS) throw new RangeError(`${name} exceeds ${MAX_RECIPIENTS} recipients`);

  const recipients = input.map((recipient, index) => requireString(recipient, `${name}[${index}]`, 320, {
    pattern: /^[^\s@,<>]+@[^\s@,<>]+$/,
  }));
  if (new Set(recipients.map(recipient => recipient.toLowerCase())).size !== recipients.length) {
    throw new TypeError(`${name} contains duplicate recipients`);
  }
  return recipients;
}

function headersFrom(value) {
  const headers = value?.payload?.headers
    || value?.message?.payload?.headers
    || value?.headers
    || value?.Headers
    || {};
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.slice(0, 100)
      .filter(header => typeof header?.name === 'string')
      .map(header => [header.name.toLowerCase().slice(0, 200), String(header.value || '').slice(0, 10_000)]));
  }
  if (headers && typeof headers === 'object') {
    return Object.fromEntries(Object.entries(headers).slice(0, 100)
      .filter(([, headerValue]) => typeof headerValue === 'string' || typeof headerValue === 'number')
      .map(([name, headerValue]) => [name.toLowerCase().slice(0, 200), String(headerValue).slice(0, 10_000)]));
  }
  return {};
}

function decodeBase64Url(value, maxLength = MAX_BODY_LENGTH) {
  if (typeof value !== 'string' || !value || value.length > maxLength * 2) return '';
  try {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      .toString('utf8')
      .slice(0, maxLength);
  } catch {
    return '';
  }
}

function bodyFromPayload(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 20) return '';
  const mimeType = String(payload.mimeType || '').toLowerCase();
  const direct = decodeBase64Url(payload.body?.data);
  if (direct && (mimeType.startsWith('text/') || !mimeType)) return direct;

  const parts = Array.isArray(payload.parts) ? payload.parts.slice(0, 100) : [];
  const textPart = parts.find(part => String(part?.mimeType || '').toLowerCase() === 'text/plain');
  const htmlPart = parts.find(part => String(part?.mimeType || '').toLowerCase() === 'text/html');
  for (const part of [textPart, htmlPart, ...parts]) {
    const body = bodyFromPayload(part, depth + 1);
    if (body) return body;
  }
  return '';
}

function mimeBodyFromPayload(payload, targetMimeType, maxLength, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 20) return '';
  const mimeType = String(payload.mimeType || '').toLowerCase();
  if (mimeType === targetMimeType) {
    const direct = decodeBase64Url(payload.body?.data, maxLength);
    if (direct) return direct;
  }
  for (const part of Array.isArray(payload.parts) ? payload.parts.slice(0, 100) : []) {
    const body = mimeBodyFromPayload(part, targetMimeType, maxLength, depth + 1);
    if (body) return body;
  }
  return '';
}

function extractBody(value) {
  const candidates = [
    value?.body,
    value?.Body,
    value?.text,
    value?.message?.body,
    bodyFromPayload(value?.payload),
    bodyFromPayload(value?.message?.payload),
  ];
  const found = candidates.find(candidate => typeof candidate === 'string' && candidate.length > 0) || '';
  return found.slice(0, MAX_BODY_LENGTH);
}

function extractHtmlBody(value, maxLength = MAX_HTML_BODY_LENGTH) {
  const candidates = [
    value?.htmlBody,
    value?.html,
    mimeBodyFromPayload(value?.payload, 'text/html', maxLength),
    mimeBodyFromPayload(value?.message?.payload, 'text/html', maxLength),
  ];
  const found = candidates.find(candidate => typeof candidate === 'string' && candidate.length > 0) || '';
  return found.slice(0, maxLength);
}

export function normalizeGogMessage(message, {
  includeBody = true,
  bodyLimit = MAX_BODY_LENGTH,
  htmlBodyLimit = MAX_HTML_BODY_LENGTH,
} = {}) {
  // `gog gmail get` wraps the Gmail resource in `message` while keeping its
  // normalized body and headers at the top level. Merge both shapes so exact-
  // message fallbacks do not accidentally discard the readable body.
  const value = message?.message && typeof message.message === 'object'
    ? { ...message, ...message.message }
    : message;
  const headers = headersFrom(value || {});
  const id = String(value?.id || value?.Id || '');
  const body = includeBody ? extractBody(value).slice(0, Math.max(0, bodyLimit)) : '';
  const htmlBody = includeBody ? extractHtmlBody(value, Math.max(0, htmlBodyLimit)) : '';
  const labels = value?.labelIds || value?.LabelIds || value?.labels || value?.Labels;

  return {
    id,
    messageId: id,
    threadId: String(value?.threadId || value?.ThreadId || ''),
    snippet: String(value?.snippet || value?.Snippet || '').slice(0, 10_000),
    subject: normalizeEmailHeaderText(headers.subject || value?.subject || value?.Subject).slice(0, 2_000),
    from: normalizeEmailHeaderText(headers.from || value?.from || value?.From).slice(0, 2_000),
    to: normalizeEmailHeaderText(headers.to || value?.to || value?.To).slice(0, 4_000),
    cc: normalizeEmailHeaderText(headers.cc || value?.cc || value?.Cc).slice(0, 4_000),
    date: normalizeEmailHeaderText(headers.date || value?.date || value?.Date).slice(0, 200),
    labelIds: Array.isArray(labels)
      ? [...labels].slice(0, 100).map(String)
      : [],
    historyId: String(value?.historyId || value?.HistoryId || ''),
    internalDate: String(value?.internalDate || value?.InternalDate || ''),
    headers,
    body,
    ...(includeBody ? { htmlBody } : {}),
    attachments: collectMessageAttachments(value),
  };
}

export class GogAdapter extends GmailAdapter {
  #labelCache = new Map();
  #execute;
  #command;

  constructor({ execute = defaultExecute, command = 'gog' } = {}) {
    super();
    if (typeof execute !== 'function') throw new TypeError('execute must be a function');
    this.#execute = execute;
    this.#command = command;
  }

  async #run(args, { force = false } = {}) {
    try {
      return await this.#execute(
        this.#command,
        [...args, ...GOG_FLAGS, ...(force ? ['--force'] : [])],
        EXEC_OPTIONS,
      );
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('gog CLI not found. Install gogcli: https://gogcli.sh');
      throw error;
    }
  }

  async #runJson(args, options) {
    const { stdout } = await this.#run(args, options);
    return parseJson(stdout);
  }

  async fetchUnread(account, searchQuery = 'is:unread newer_than:1d', max = 50) {
    const { messages } = await this.searchMailbox(account, searchQuery, max);
    return messages;
  }

  async searchMailbox(account, query, limit = 25) {
    const safeAccount = validateAccount(account);
    const safeQuery = requireString(query, 'query', MAX_QUERY_LENGTH);
    const safeLimit = Number(limit);
    if (!Number.isSafeInteger(safeLimit) || safeLimit < 1 || safeLimit > 100) {
      throw new RangeError('limit must be an integer from 1 to 100');
    }

    const data = await this.#runJson([
      'gmail', 'messages', 'search', safeQuery,
      '--max', String(safeLimit),
      '--account', safeAccount,
    ]);
    if (!data) return { messages: [], nextPageToken: null };
    const rawMessages = Array.isArray(data) ? data : (data.messages || data.Messages || []);
    return {
      messages: Array.isArray(rawMessages)
        ? rawMessages.slice(0, safeLimit).map(message => normalizeGogMessage(message, { includeBody: false }))
        : [],
      nextPageToken: String(data?.nextPageToken || data?.NextPageToken || '') || null,
    };
  }

  async searchAllMailbox(account, query, limit = MAX_SYNC_RESULTS) {
    const safeAccount = validateAccount(account);
    const safeQuery = requireString(query, 'query', MAX_QUERY_LENGTH);
    const safeLimit = Number(limit);
    if (!Number.isSafeInteger(safeLimit) || safeLimit < 1 || safeLimit > MAX_SYNC_RESULTS) {
      throw new RangeError(`limit must be an integer from 1 to ${MAX_SYNC_RESULTS}`);
    }

    const data = await this.#runJson([
      'gmail', 'messages', 'search', safeQuery,
      '--max', String(safeLimit), '--all',
      '--account', safeAccount,
    ]);
    if (!data) return { messages: [], complete: false };
    const rawMessages = Array.isArray(data) ? data : (data.messages || data.Messages || []);
    return {
      messages: Array.isArray(rawMessages)
        ? rawMessages.map(message => normalizeGogMessage(message, { includeBody: false }))
        : [],
      complete: !String(data?.nextPageToken || data?.NextPageToken || ''),
    };
  }

  async getHistory(account, since, limit = MAX_SYNC_RESULTS) {
    const safeAccount = validateAccount(account);
    const safeSince = requireString(String(since || ''), 'historyId', 256, {
      pattern: /^\d+$/,
    });
    const safeLimit = Number(limit);
    if (!Number.isSafeInteger(safeLimit) || safeLimit < 1 || safeLimit > MAX_SYNC_RESULTS) {
      throw new RangeError(`limit must be an integer from 1 to ${MAX_SYNC_RESULTS}`);
    }
    return await this.#runJson([
      'gmail', 'history', '--since', safeSince,
      '--max', String(safeLimit), '--all',
      '--account', safeAccount,
    ]) || {};
  }

  async getMessage(account, messageId) {
    const data = await this.#runJson([
      'gmail', 'get', validateGmailId(messageId, 'messageId'),
      '--account', validateAccount(account),
    ]);
    return data;
  }

  async getThread(account, threadId) {
    const safeThreadId = validateGmailId(threadId, 'threadId');
    const data = await this.#runJson([
      'gmail', 'thread', 'get', safeThreadId,
      '--full',
      '--account', validateAccount(account),
    ]);
    const thread = data?.thread || data?.Thread || data || {};
    const rawMessages = Array.isArray(thread) ? thread : (thread.messages || thread.Messages || []);
    let bodyBudget = MAX_THREAD_BODY_LENGTH;
    let htmlBodyBudget = MAX_THREAD_HTML_BODY_LENGTH;
    const messages = (Array.isArray(rawMessages) ? rawMessages : [])
      .slice(0, MAX_THREAD_MESSAGES)
      .map(message => {
        const normalized = normalizeGogMessage(message, {
          bodyLimit: bodyBudget,
          htmlBodyLimit: htmlBodyBudget,
        });
        bodyBudget = Math.max(0, bodyBudget - normalized.body.length);
        htmlBodyBudget = Math.max(0, htmlBodyBudget - normalized.htmlBody.length);
        return normalized;
      });
    return {
      id: String(thread.id || thread.Id || safeThreadId),
      historyId: String(thread.historyId || thread.HistoryId || ''),
      messages,
    };
  }

  async getAttachment(account, messageId, attachmentId, { maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
    const safeAccount = validateAccount(account);
    const safeMessageId = validateGmailId(messageId, 'messageId');
    const safeAttachmentId = validateAttachmentId(attachmentId);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ATTACHMENT_BYTES) {
      throw new RangeError(`maxBytes must be an integer from 1 to ${MAX_ATTACHMENT_BYTES}`);
    }

    const directory = await mkdtemp(join(tmpdir(), 'winnow-attachment-'));
    const path = join(directory, 'attachment');
    try {
      await this.#runJson([
        'gmail', 'attachment', safeMessageId, safeAttachmentId,
        '--account', safeAccount,
        '--out', path,
      ]);
      const file = await stat(path);
      if (!file.isFile() || file.size > maxBytes) {
        const error = new Error('attachment_size_not_supported');
        error.code = 'attachment_size_not_supported';
        throw error;
      }
      return await readFile(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async reply(account, reference, draft) {
    const messageId = validateGmailId(reference?.messageId, 'messageId');
    const safeAccount = validateAccount(account);
    const body = requireString(draft?.body, 'body', MAX_BODY_LENGTH, { preserve: true });
    const to = normalizeRecipientList(draft?.to, 'to');
    const cc = normalizeRecipientList(draft?.cc, 'cc');
    const bcc = normalizeRecipientList(draft?.bcc, 'bcc');
    const args = ['gmail', 'reply', messageId, '--body', body, '--no-quote', '--account', safeAccount];
    for (const recipient of to) args.push('--to', recipient);
    for (const recipient of cc) args.push('--cc', recipient);
    for (const recipient of bcc) args.push('--bcc', recipient);
    if (draft?.subject != null) args.push('--subject', requireString(draft.subject, 'subject', 998));
    return this.#runJson(args);
  }

  async forward(account, reference, draft) {
    const messageId = validateGmailId(reference?.messageId, 'messageId');
    const safeAccount = validateAccount(account);
    const to = normalizeRecipientList(draft?.to, 'to', { required: true });
    const cc = normalizeRecipientList(draft?.cc, 'cc');
    const bcc = normalizeRecipientList(draft?.bcc, 'bcc');
    const args = [
      'gmail', 'forward', messageId,
      '--to', to.join(','),
      '--account', safeAccount,
    ];
    if (cc.length) args.push('--cc', cc.join(','));
    if (bcc.length) args.push('--bcc', bcc.join(','));
    if (draft?.note != null) {
      args.push('--note', requireString(draft.note, 'note', MAX_NOTE_LENGTH, { allowEmpty: true, preserve: true }));
    }
    if (draft?.skipAttachments === true) args.push('--skip-attachments');
    return this.#runJson(args);
  }

  async sendReply(account, messageId, draft) {
    return this.reply(account, { messageId }, draft);
  }

  async sendForward(account, messageId, draft) {
    return this.forward(account, { messageId }, draft);
  }

  async archive(account, threadId) {
    return this.modifyLabels(account, threadId, { remove: ['INBOX'] });
  }

  async unarchive(account, threadId) {
    return this.modifyLabels(account, threadId, { add: ['INBOX'] });
  }

  async markRead(account, threadId) {
    return this.modifyLabels(account, threadId, { remove: ['UNREAD'] });
  }

  async addLabel(account, threadId, label) {
    return this.modifyLabels(account, threadId, { add: [label] });
  }

  async removeLabel(account, threadId, label) {
    return this.modifyLabels(account, threadId, { remove: [label] });
  }

  async modifyLabels(account, threadId, { add = [], remove = [] }) {
    const args = [
      'gmail', 'labels', 'modify', validateGmailId(threadId, 'threadId'),
      '--account', validateAccount(account),
    ];
    if (add.length) args.push('--add', add.join(','));
    if (remove.length) args.push('--remove', remove.join(','));
    return this.#runJson(args, { force: true });
  }

  async ensureLabel(account, labelName) {
    const safeAccount = validateAccount(account);
    const safeLabelName = requireString(labelName, 'labelName', 225);
    const cacheKey = `${safeAccount}:${safeLabelName}`;
    if (this.#labelCache.has(cacheKey)) return true;

    try {
      const data = await this.#runJson([
        'gmail', 'labels', 'list',
        '--account', safeAccount,
      ]);
      const labels = Array.isArray(data) ? data : (data?.labels || data?.Labels || []);
      const exists = Array.isArray(labels) && labels.some(
        label => (label.name || label.Name || '') === safeLabelName
      );
      if (!exists) {
        console.log(`[winnow] Creating Gmail label: ${safeLabelName}`);
        await this.#runJson([
          'gmail', 'labels', 'create', safeLabelName,
          '--account', safeAccount,
        ]);
        console.log(`[winnow] ✅ Label created: ${safeLabelName}`);
      }
      this.#labelCache.set(cacheKey, true);
      return true;
    } catch (err) {
      // Don't cache on failure — retry next scan.
      console.error(`[winnow] ⚠️ Failed to ensure label "${safeLabelName}": ${err.message}`);
      return false;
    }
  }

  async getMailboxState(account, messageId) {
    const message = await this.getMessage(account, messageId);
    const labelIds = message?.labelIds
      || message?.LabelIds
      || message?.message?.labelIds
      || message?.message?.LabelIds
      || message?.payload?.labelIds
      || message?.message?.payload?.labelIds
      || [];
    const labels = Array.isArray(labelIds) ? labelIds : [];
    return {
      mailboxState: labels.includes('INBOX') ? 'inbox' : 'archived',
      unread: labels.includes('UNREAD'),
      labels,
    };
  }
}
