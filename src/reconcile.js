import { GogAdapter } from './adapters/gog.js';
import { appendEmailEvent, listDeliveryRecords, listRecentTrackedEmailItems, updateEmailItemState } from './store.js';
import { formatEmailFeedMessage, updateSlackMessage } from './notify.js';

function itemToResult(item) {
  return {
    emailItemId: item.id,
    account: item.account,
    threadId: item.threadId,
    messageId: item.messageId,
    from: item.from,
    subject: item.subject,
    summary: item.summary,
    action: item.action,
    deadline: item.deadline,
    impact: item.impact,
    handling: item.handling,
    confidence: item.confidence,
    ephemeral: item.ephemeral,
    archive: item.mailboxState === 'archived',
    unsubscribeLink: item.unsubscribeLink,
  };
}

export async function syncSlackDeliveryForItem(item, reason = 'Mailbox state changed') {
  const deliveries = listDeliveryRecords(item.id, 'slack').filter(d => d.channelId && d.messageTs);
  if (!deliveries.length) return { updated: 0 };

  const { text, blocks } = formatEmailFeedMessage(itemToResult(item));
  let updated = 0;
  for (const delivery of deliveries) {
    const result = await updateSlackMessage(delivery.messageTs, delivery.channelId, text, blocks, item.account);
    if (result.ok) updated++;
  }
  return { updated, reason };
}

export async function reconcileMailbox({ account = '', days = 7, limit = 100 } = {}) {
  const adapter = new GogAdapter();
  const items = listRecentTrackedEmailItems({ account, days, limit });
  const changes = [];

  for (const item of items) {
    try {
      const state = await adapter.getMailboxState(item.account, item.messageId);
      if (!state.mailboxState || state.mailboxState === item.mailboxState) continue;

      const updated = updateEmailItemState(item.id, {
        mailboxState: state.mailboxState,
        triageState: state.mailboxState === 'archived' ? 'manual_archived' : 'restored',
        reason: `Gmail labels changed to ${state.mailboxState}`,
      });
      appendEmailEvent('mailbox.state_changed', updated, {
        source: 'gmail_sync',
        reason: `Mailbox state changed from ${item.mailboxState} to ${state.mailboxState}`,
        metadata: { previousMailboxState: item.mailboxState, labels: state.labels },
      });
      await syncSlackDeliveryForItem(updated, 'Mailbox reconciliation');
      changes.push(updated);
    } catch (err) {
      console.error(`[winnow/reconcile] Failed to reconcile ${item.account}/${item.messageId}: ${err.message}`);
    }
  }

  return { checked: items.length, changed: changes.length, changes };
}
