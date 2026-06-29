import { GogAdapter } from './adapters/gog.js';
import {
  appendEmailEvent,
  findEmailItemByGmail,
  getEmailItem,
  makeEmailItemId,
  resultToEmailItem,
  updateEmailItemState,
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
  if (emailItemId) {
    const item = getEmailItem(emailItemId);
    if (item) return item;
  }
  const item = findEmailItemByGmail({ account, messageId, threadId });
  if (item) return item;
  return minimalItem({ account, threadId, messageId, from, subject, summary });
}

export async function archiveEmail({
  account,
  threadId,
  messageId = '',
  emailItemId = '',
  source = 'cli',
  from = '',
  subject = '',
  summary = '',
  reason = 'Archived',
} = {}) {
  if (!account || !threadId) throw new Error('account and threadId are required');
  const adapter = adapterFor();
  await adapter.archive(account, threadId);
  await adapter.markRead(account, threadId);
  await adapter.addLabel(account, threadId, ARCHIVED_LABEL);
  const item = resolveItem({ emailItemId, account, threadId, messageId, from, subject, summary });
  const updated = updateEmailItemState(item.id, {
    triageState: 'manual_archived',
    mailboxState: 'archived',
    reason,
  });
  appendEmailEvent('email.manual_archived', updated, { source, reason });
  await syncSlackDeliveryForItem(updated, reason);
  return updated;
}

export async function moveEmailToInbox({
  account,
  threadId,
  messageId = '',
  emailItemId = '',
  source = 'cli',
  from = '',
  subject = '',
  summary = '',
  reason = 'Moved to inbox',
} = {}) {
  if (!account || !threadId) throw new Error('account and threadId are required');
  const adapter = adapterFor();
  await adapter.unarchive(account, threadId);
  await adapter.removeLabel(account, threadId, ARCHIVED_LABEL);
  const item = resolveItem({ emailItemId, account, threadId, messageId, from, subject, summary });
  const updated = updateEmailItemState(item.id, {
    triageState: 'restored',
    mailboxState: 'inbox',
    reason,
  });
  appendEmailEvent('email.restored_to_inbox', updated, { source, reason });
  await syncSlackDeliveryForItem(updated, reason);
  return updated;
}

export async function markEmailRead({ account, threadId } = {}) {
  if (!account || !threadId) throw new Error('account and threadId are required');
  const adapter = adapterFor();
  await adapter.markRead(account, threadId);
  return { ok: true };
}

export async function markEmailUnread({ account, threadId } = {}) {
  if (!account || !threadId) throw new Error('account and threadId are required');
  const adapter = adapterFor();
  await adapter.modifyLabels(account, threadId, { add: ['UNREAD'] });
  return { ok: true };
}
