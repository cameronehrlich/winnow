import { GogAdapter } from './adapters/gog.js';
import {
  appendEmailEvent,
  findEmailItemByGmail,
  getEmailItem,
  makeEmailItemId,
  resultToEmailItem,
  updateEmailThreadState,
  upsertEmailItem,
} from './store.js';
import { syncSlackDeliveryForItem } from './reconcile.js';

const ARCHIVED_LABEL = 'winnow/archived';

function adapterFor() {
  return new GogAdapter();
}

function minimalItem({ account, threadId, messageId = '', from = '', subject = '', summary = '' }) {
  return upsertEmailItem(resultToEmailItem({
    account,
    messageId,
    threadId,
    from,
    subject: subject || '(unknown subject)',
    summary,
    archive: false,
    confidence: null,
  }, {
    id: makeEmailItemId(account, messageId, threadId),
    account,
    messageId,
    threadId,
    triageState: 'kept',
    mailboxState: 'inbox',
  }));
}

function resolveItem({ emailItemId, account, threadId, messageId, from, subject, summary }) {
  const existing = lookupItem({ emailItemId, account, threadId, messageId });
  if (existing) return existing;
  return minimalItem({ account, threadId, messageId, from, subject, summary });
}

function lookupItem({ emailItemId, account, threadId, messageId }) {
  if (emailItemId) {
    const item = getEmailItem(emailItemId);
    if (item) return item;
  }
  return findEmailItemByGmail({ account, messageId, threadId });
}

function latestThreadItem(account, threadId, fallback = null) {
  if (!account || !threadId) return fallback;
  return findEmailItemByGmail({ account, threadId }) || fallback;
}

export async function archiveEmail({
  account,
  threadId,
  messageId = '',
  emailItemId = '',
  source = 'cli',
  syncSlack = true,
  from = '',
  subject = '',
  summary = '',
  reason = 'Archived',
} = {}) {
  if (!account || !threadId) throw new Error('account and threadId are required');
  const existing = lookupItem({ emailItemId, account, threadId, messageId });
  const current = latestThreadItem(account, threadId, existing);
  if (current?.mailboxState === 'archived' && current.readState === 'read') {
    return updateEmailThreadState(current.id, {
      triageState: 'manual_archived', mailboxState: 'archived', readState: 'read', reason,
    });
  }

  const adapter = adapterFor();
  await adapter.archive(account, threadId);
  await adapter.markRead(account, threadId);
  await adapter.addLabel(account, threadId, ARCHIVED_LABEL);
  const item = existing || resolveItem({ emailItemId, account, threadId, messageId, from, subject, summary });
  const updated = updateEmailThreadState(item.id, {
    triageState: 'manual_archived',
    mailboxState: 'archived',
    readState: 'read',
    reason,
  });
  appendEmailEvent('email.manual_archived', updated, { source, reason });
  if (syncSlack) await syncSlackDeliveryForItem(updated, reason);
  return updated;
}

export async function moveEmailToInbox({
  account,
  threadId,
  messageId = '',
  emailItemId = '',
  source = 'cli',
  syncSlack = true,
  from = '',
  subject = '',
  summary = '',
  reason = 'Moved to inbox',
} = {}) {
  if (!account || !threadId) throw new Error('account and threadId are required');
  const existing = lookupItem({ emailItemId, account, threadId, messageId });
  const current = latestThreadItem(account, threadId, existing);
  if (current?.mailboxState === 'inbox') {
    return updateEmailThreadState(current.id, {
      triageState: 'restored', mailboxState: 'inbox', reason,
    });
  }

  const adapter = adapterFor();
  await adapter.unarchive(account, threadId);
  await adapter.removeLabel(account, threadId, ARCHIVED_LABEL);
  const item = existing || resolveItem({ emailItemId, account, threadId, messageId, from, subject, summary });
  const updated = updateEmailThreadState(item.id, {
    triageState: 'restored',
    mailboxState: 'inbox',
    reason,
  });
  appendEmailEvent('email.restored_to_inbox', updated, { source, reason });
  if (syncSlack) await syncSlackDeliveryForItem(updated, reason);
  return updated;
}

export async function markEmailRead({
  account,
  threadId,
  messageId = '',
  emailItemId = '',
  source = 'cli',
  from = '',
  subject = '',
  summary = '',
  reason = 'Marked read',
} = {}) {
  if (!account || !threadId) throw new Error('account and threadId are required');
  const existing = lookupItem({ emailItemId, account, threadId, messageId });
  const current = latestThreadItem(account, threadId, existing);
  if (current?.readState === 'read') {
    return updateEmailThreadState(current.id, { readState: 'read' });
  }
  const adapter = adapterFor();
  await adapter.markRead(account, threadId);
  const item = existing || resolveItem({ emailItemId, account, threadId, messageId, from, subject, summary });
  const updated = updateEmailThreadState(item.id, { readState: 'read' });
  appendEmailEvent('mailbox.state_changed', updated, {
    source,
    reason,
    metadata: { readState: 'read' },
  });
  return updated;
}

export async function markEmailUnread({
  account,
  threadId,
  messageId = '',
  emailItemId = '',
  source = 'cli',
  from = '',
  subject = '',
  summary = '',
  reason = 'Marked unread',
} = {}) {
  if (!account || !threadId) throw new Error('account and threadId are required');
  const existing = lookupItem({ emailItemId, account, threadId, messageId });
  const current = latestThreadItem(account, threadId, existing);
  if (current?.readState === 'unread') {
    return updateEmailThreadState(current.id, { readState: 'unread' });
  }
  const adapter = adapterFor();
  await adapter.modifyLabels(account, threadId, { add: ['UNREAD'] });
  const item = existing || resolveItem({ emailItemId, account, threadId, messageId, from, subject, summary });
  const updated = updateEmailThreadState(item.id, { readState: 'unread' });
  appendEmailEvent('mailbox.state_changed', updated, {
    source,
    reason,
    metadata: { readState: 'unread' },
  });
  return updated;
}
