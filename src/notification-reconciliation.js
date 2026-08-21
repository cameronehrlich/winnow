import {
  findEmailItemByGmail,
  getEmailItem,
  getMailboxCounts,
} from './store.js';

function trackedItemFor(context) {
  const exact = context.emailId ? getEmailItem(context.emailId) : null;
  const account = context.account || exact?.account || '';
  const threadId = context.threadId || exact?.threadId || '';
  if (account && threadId) {
    return findEmailItemByGmail({ account, threadId }) || exact;
  }
  return exact;
}

export function reconcileDeliveredNotifications(contexts) {
  const clearNotifications = [];
  for (const context of contexts) {
    const item = trackedItemFor(context);
    if (!item || item.mailboxState !== 'inbox' || item.readState === 'read') {
      clearNotifications.push(context);
    }
  }
  return {
    checked: contexts.length,
    badge: getMailboxCounts().inbox,
    clearNotifications,
  };
}
