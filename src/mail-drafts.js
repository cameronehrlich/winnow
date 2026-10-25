import { createHash } from 'node:crypto';
import { GogAdapter, normalizeGogMessage } from './adapters/gog.js';
import { getActiveAccounts, getAccountConfig } from './config.js';
import { normalizeMailRecipients, normalizeAssistantDraft } from './assistant-drafts.js';
import { headerAddresses, resolveMailIdentity } from './mail-identity.js';
import { emailBodyToText } from './message-content.js';
import { embedInlineImages } from './email-inline-images.js';
import { MAX_ATTACHMENT_BYTES } from './email-attachments.js';
import {
  claimGmailDraftOperation, finishGmailDraftOperation,
  getGmailDraftOperation, gmailDraftOrigin, getAssistantConversation, getAssistantMessage, getEmailItem,
  getLatestPendingAssistantProposal,
  assistantDraftSaveBlocked,
} from './store.js';

export class MailDraftError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new MailDraftError(status, code, message); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
const locks = new Set();
const pendingLists = new Map();
const adapterFor = options => options.adapter || new GogAdapter();

function activeAccount(value) {
  const account = getActiveAccounts().find(item => item.email.toLowerCase() === String(value).toLowerCase());
  if (!account) fail(400, 'invalid_account', 'Choose an active Winnow account.');
  return account.email;
}
function identifier(value, name = 'draftId') {
  const pattern = name === 'draftId' ? /^[\x21-\x7e]{1,256}$/ : /^[A-Za-z0-9_-]{1,256}$/;
  if (typeof value !== 'string' || !pattern.test(value)) fail(400, 'invalid_draft_request', `Invalid ${name}.`);
  return value;
}
function requestKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail(400, 'invalid_idempotency_key', 'A request identifier is required.');
  return value;
}
async function locked(account, draftId, operation) {
  const key = `${account}\0${draftId}`;
  if (locks.has(key)) fail(409, 'draft_busy', 'This draft is being changed on another device. Refresh and try again.');
  locks.add(key);
  try { return await operation(); } finally { locks.delete(key); }
}
function isMissing(error) {
  return /\b404\b|notFound|requested entity was not found/i.test(String(error?.stderr || error?.message || ''));
}
async function providerDraft(adapter, account, id, signal = AbortSignal.timeout(10000)) {
  try { return await adapter.getDraft(account, id, { signal }); }
  catch (error) {
    if (isMissing(error)) fail(404, 'draft_not_found', 'This draft was sent or removed in Gmail. Refresh Drafts.');
    fail(502, 'draft_unavailable', 'Gmail could not load this draft. Please try again.');
  }
}
function normalizeDraft(account, raw) {
  const message = normalizeGogMessage(raw.message, { includeHtml: true });
  const origin = gmailDraftOrigin(account, raw.id);
  // Older gog releases rebuild MIME on update. Never risk dropping rich content,
  // attachments, or unknown reply headers: those drafts remain view/send-as-is.
  const editable = !message.htmlBody && !message.attachments.length && message.body.length <= 20000
    && Boolean(origin?.replyMessageId && origin.replyHeaders?.['in-reply-to'])
    && origin.threadId === message.threadId
    && ['in-reply-to', 'references'].every(key => (message.headers[key] || '') === (origin.replyHeaders[key] || ''));
  return {
    account, draftId: raw.id, messageId: message.id, threadId: message.threadId,
    from: message.from, to: message.to, cc: message.cc, bcc: message.bcc,
    subject: message.subject, snippet: message.snippet || emailBodyToText(message.body).slice(0, 300),
    date: message.date, internalDate: message.internalDate,
    body: emailBodyToText(message.body), htmlBody: message.htmlBody || '',
    attachments: message.attachments, revision: hash(raw.message), editable,
    sendable: ['to', 'cc', 'bcc'].some(field => headerAddresses(message[field]).length > 0),
  };
}
function assertRevision(actual, expected) {
  if (typeof expected !== 'string' || actual !== expected) {
    fail(409, 'draft_changed', 'This draft changed in Gmail or on another device. Reload it before saving or sending.');
  }
}
function normalizedFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['from', 'to', 'cc', 'bcc', 'subject', 'body'].includes(key))) {
    fail(400, 'invalid_draft', 'Check the draft fields.');
  }
  if (typeof value.subject !== 'string' || value.subject.length > 500 || /[\r\n\0]/.test(value.subject)
    || !value.subject.trim() || typeof value.body !== 'string' || !value.body.trim() || value.body.length > 20000) {
    fail(400, 'invalid_draft', 'Add a one-line subject and a message of up to 20,000 characters before saving.');
  }
  const seen = new Set();
  try {
    return {
      from: normalizeMailRecipients([value.from], 'from', { required: true })[0],
      ...Object.fromEntries(['to', 'cc', 'bcc'].map(field => [field,
        normalizeMailRecipients(value[field] || [], field).filter(address => {
          if (seen.has(address)) return false;
          seen.add(address); return true;
        }),
      ])), subject: value.subject, body: value.body,
    };
  } catch { fail(400, 'invalid_draft', 'Check the From, To, Cc, and Bcc email addresses.'); }
}
async function verifySender(adapter, account, from) {
  const aliases = await adapter.listSendAs(account, { signal: AbortSignal.timeout(10000) });
  if (!aliases.some(alias => (alias.isPrimary || alias.verificationStatus === 'accepted')
    && alias.sendAsEmail.toLowerCase() === from.toLowerCase())) {
    fail(409, 'sender_not_verified', 'This From address is not a verified Gmail sending identity. Edit it in Gmail before sending.');
  }
}
function replay(operation, { kind, account, targetId, digest }) {
  if (operation.kind !== kind || operation.account !== account || operation.target_id !== targetId || operation.digest !== digest) {
    fail(409, 'draft_request_conflict', 'This request no longer matches the saved operation. Refresh Drafts.');
  }
  if (operation.status === 'succeeded') return JSON.parse(operation.result_json);
  fail(409, 'draft_operation_unconfirmed', 'Gmail has not confirmed the previous operation. Check Gmail Drafts and Sent before trying again. Winnow will not risk a duplicate.');
}

export async function getMailDraft({ account, draftId }, options = {}) {
  account = activeAccount(account); identifier(draftId);
  const adapter = adapterFor(options);
  const raw = await providerDraft(adapter, account, draftId, options.signal);
  const result = normalizeDraft(account, raw);
  if (options.includeInlineImages && result.htmlBody) {
    const display = { id: result.messageId, htmlBody: result.htmlBody };
    await embedInlineImages([display], [normalizeGogMessage(raw.message, { includeHtml: true })], {
      account, focusedMessageId: result.messageId, adapter,
    });
    result.htmlBody = display.htmlBody;
  }
  return result;
}

export async function listMailDrafts(query, options = {}) {
  if (options.adapter) return loadMailDrafts(query, options);
  const key = JSON.stringify({ ...query, accounts: [...query.accounts].sort() });
  const pending = pendingLists.get(key);
  if (pending) return pending;
  const request = loadMailDrafts(query, options);
  pendingLists.set(key, request);
  try { return await request; } finally { if (pendingLists.get(key) === request) pendingLists.delete(key); }
}

async function loadMailDrafts({ accounts, limit = 20, cursor = '' }, options = {}) {
  accounts = accounts.map(activeAccount).sort();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_limit', 'Choose up to 100 drafts per account.');
  let pages = Object.fromEntries(accounts.map(account => [account, '']));
  if (cursor) {
    try {
      if (cursor.length > 20000) throw new Error();
      pages = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (JSON.stringify(Object.keys(pages).sort()) !== JSON.stringify(accounts)
        || Object.values(pages).some(token => token !== null && (typeof token !== 'string' || token.length > 4096))) throw new Error();
    } catch { fail(400, 'invalid_cursor', 'Refresh Drafts to start a new page.'); }
  }
  const adapter = adapterFor(options);
  const signal = options.signal || AbortSignal.timeout(15000);
  const startingPages = { ...pages };
  const unavailableAccounts = new Set();
  const refs = [];
  await Promise.all(accounts.map(async account => {
    if (pages[account] === null) return;
    try {
      const result = await adapter.listDrafts(account, { limit, pageToken: pages[account], signal });
      pages[account] = result.nextPageToken || null;
      refs.push(...result.drafts.slice(0, limit).map(draft => ({ account, draftId: identifier(draft.id) })));
    } catch { unavailableAccounts.add(account); }
  }));
  const items = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, refs.length) }, async () => {
    while (index < refs.length) {
      const ref = refs[index++];
      if (signal.aborted) {
        unavailableAccounts.add(ref.account); pages[ref.account] = startingPages[ref.account]; continue;
      }
      try {
        const draft = await getMailDraft(ref, { adapter, signal });
        // Mailbox pages carry previews, not every complete body/HTML payload.
        items.push({ ...draft, body: '', htmlBody: '' });
      }
      catch (error) {
        if (error.status !== 404) {
          unavailableAccounts.add(ref.account); pages[ref.account] = startingPages[ref.account];
        }
      }
    }
  }));
  if (accounts.length && unavailableAccounts.size === accounts.length && !items.length) {
    fail(502, 'drafts_unavailable', 'Gmail could not load your drafts. Please try again.');
  }
  items.sort((a, b) => Number(b.internalDate || Date.parse(b.date) || 0) - Number(a.internalDate || Date.parse(a.date) || 0)
    || a.account.localeCompare(b.account) || a.draftId.localeCompare(b.draftId));
  return {
    items, unavailableAccounts: [...unavailableAccounts],
    nextCursor: Object.values(pages).some(token => token !== null) ? Buffer.from(JSON.stringify(pages)).toString('base64url') : null,
  };
}

export async function updateMailDraft({ account, draftId, revision, fields }, options = {}) {
  account = activeAccount(account); identifier(draftId);
  const adapter = adapterFor(options);
  return locked(account, draftId, async () => {
    const current = await getMailDraft({ account, draftId }, { adapter });
    assertRevision(current.revision, revision);
    if (!current.editable) fail(409, 'draft_edit_in_gmail', 'Edit this draft in Gmail to preserve its formatting, attachments, and reply headers. You can send it unchanged here.');
    if (getGmailDraftOperation('send', account, draftId)) fail(409, 'draft_operation_unconfirmed', 'Check Gmail Sent before changing this draft.');
    const normalized = normalizedFields(fields);
    await verifySender(adapter, account, normalized.from);
    try { await adapter.saveDraft(account, normalized, { draftId, replyMessageId: gmailDraftOrigin(account, draftId)?.replyMessageId || '' }); }
    catch { fail(502, 'draft_save_unconfirmed', 'Gmail could not confirm the save. Reload the draft before editing further.'); }
    return getMailDraft({ account, draftId }, { adapter });
  });
}

export async function createMailDraft({ account, fields, idempotencyKey, sourceMessageId = '' }, options = {}) {
  account = activeAccount(account); requestKey(idempotencyKey);
  if (sourceMessageId) identifier(sourceMessageId, 'sourceMessageId');
  const adapter = adapterFor(options);
  let replyMessageId = '';
  let sourceSaveGuard = () => {};
  if (sourceMessageId) {
    const message = getAssistantMessage(sourceMessageId);
    const conversation = message && getAssistantConversation(message.conversationId);
    const draft = normalizeAssistantDraft(message?.draft);
    const pending = conversation && getLatestPendingAssistantProposal(conversation.id);
    if (pending?.tool?.startsWith('mail.send_')) {
      fail(409, 'draft_send_pending', 'Confirm or cancel the pending send before saving another copy.');
    }
    if (!conversation || conversation.account !== account || message.role !== 'assistant' || draft?.kind !== 'reply'
      || message.proposal) fail(400, 'invalid_source_draft', 'Only an unsent email reply draft can be saved from this conversation.');
    sourceSaveGuard = () => {
      if (assistantDraftSaveBlocked(conversation.id, message.createdAt)) {
        fail(409, 'draft_send_pending', 'Wait for the current Winnow action to finish and check Sent before saving another copy of this reply.');
      }
    };
    sourceSaveGuard();
    const item = getEmailItem(conversation.emailItemId);
    if (!item || item.account !== account) fail(400, 'invalid_source_draft', 'The original email is no longer available.');
    replyMessageId = item.messageId;
    const source = normalizeGogMessage(await adapter.getMessage(account, replyMessageId));
    const identity = resolveMailIdentity(account, source, await adapter.listSendAs(account), getAccountConfig(account));
    fields = { from: identity.from, to: draft.to.length ? draft.to : headerAddresses(source.headers['reply-to'] || source.from)
      .filter(address => !identity.ownedAddresses.includes(address)), cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body };
  }
  const normalized = normalizedFields(fields);
  const spec = { kind: 'create', account, targetId: sourceMessageId ? `assistant:${sourceMessageId}` : `new:${idempotencyKey}`, digest: hash(normalized) };
  const existing = getGmailDraftOperation(spec.kind, account, spec.targetId);
  if (existing) {
    if (!sourceMessageId && existing.digest !== spec.digest) replay(existing, spec);
    // Opening an already saved chat draft must not overwrite edits made elsewhere.
    if (existing.status === 'succeeded') return getMailDraft({ account, draftId: JSON.parse(existing.result_json).draftId }, { adapter });
    replay(existing, spec);
  }
  await verifySender(adapter, account, normalized.from);
  sourceSaveGuard();
  const claim = claimGmailDraftOperation({ ...spec, key: idempotencyKey });
  if (!claim.claimed) {
    const result = replay(claim.operation, spec);
    return getMailDraft({ account, draftId: result.draftId }, { adapter });
  }
  let saved;
  try {
    saved = await adapter.saveDraft(account, normalized, { replyMessageId });
    identifier(saved.draftId);
    finishGmailDraftOperation(idempotencyKey, 'succeeded', { account, draftId: saved.draftId, replyMessageId });
  } catch {
    finishGmailDraftOperation(idempotencyKey, 'uncertain');
    fail(409, 'draft_operation_unconfirmed', 'Gmail could not confirm the new draft. Check Gmail Drafts before creating it again.');
  }
  const raw = await providerDraft(adapter, account, saved.draftId);
  const message = normalizeGogMessage(raw.message);
  finishGmailDraftOperation(idempotencyKey, 'succeeded', {
    account, draftId: saved.draftId, replyMessageId, threadId: message.threadId,
    replyHeaders: Object.fromEntries(['in-reply-to', 'references'].map(key => [key, message.headers[key] || ''])),
  });
  return normalizeDraft(account, raw);
}

export async function sendMailDraft({ account, draftId, revision, idempotencyKey, confirmed }, options = {}) {
  account = activeAccount(account); identifier(draftId); requestKey(idempotencyKey);
  if (confirmed !== true) fail(400, 'draft_confirmation_required', 'Review and confirm the draft before sending.');
  if (typeof revision !== 'string' || !revision || revision.length > 128) {
    fail(400, 'invalid_revision', 'Reload the draft before sending.');
  }
  const spec = { kind: 'send', account, targetId: draftId, digest: hash(revision) };
  const existing = getGmailDraftOperation('send', account, draftId);
  if (existing) return replay(existing, spec);
  const adapter = adapterFor(options);
  return locked(account, draftId, async () => {
    const current = await getMailDraft({ account, draftId }, { adapter });
    assertRevision(current.revision, revision);
    if (!current.sendable) fail(400, 'draft_recipient_required', 'Add at least one To, Cc, or Bcc recipient before sending.');
    const from = headerAddresses(current.from);
    if (from.length !== 1) fail(409, 'sender_not_verified', 'Check this draft’s From address in Gmail.');
    await verifySender(adapter, account, from[0]);
    const claim = claimGmailDraftOperation({ ...spec, key: idempotencyKey });
    if (!claim.claimed) return replay(claim.operation, spec);
    try {
      // Send the Gmail draft itself. Never rebuild its MIME or retry this call.
      const sent = await adapter.sendDraft(account, draftId);
      const result = { ok: true, account, draftId, ...sent };
      finishGmailDraftOperation(idempotencyKey, 'succeeded', result);
      return result;
    } catch {
      finishGmailDraftOperation(idempotencyKey, 'uncertain');
      fail(409, 'draft_send_unconfirmed', 'Gmail has not confirmed this send. Check Sent before trying again; Winnow will not send it twice.');
    }
  });
}

export async function mailDraftAttachment({ account, draftId, attachmentId }, options = {}) {
  const adapter = adapterFor(options);
  const draft = await getMailDraft({ account, draftId }, { adapter });
  const attachment = draft.attachments.find(item => item.attachmentId === attachmentId);
  if (!attachment) fail(404, 'attachment_not_found', 'This attachment is no longer part of the draft.');
  if (attachment.sizeBytes < 1 || attachment.sizeBytes > MAX_ATTACHMENT_BYTES) fail(413, 'attachment_too_large', 'Open this attachment in Gmail.');
  const data = await adapter.getAttachment(draft.account, draft.messageId, attachmentId, { maxBytes: attachment.sizeBytes });
  if (!Buffer.isBuffer(data) || data.length > attachment.sizeBytes || data.length > MAX_ATTACHMENT_BYTES) {
    fail(413, 'attachment_too_large', 'Gmail returned an unexpectedly large attachment.');
  }
  return { attachment, data };
}
