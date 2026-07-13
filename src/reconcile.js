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

export async function reconcileMailbox({ account = '', days = 7, limit = 100, adapter = new GogAdapter() } = {}) {
  const items = listRecentTrackedEmailItems({ account, days, limit });
  const changes = [];

  for (const item of items) {
    try {
      const state = await adapter.getMailboxState(item.account, item.messageId);
      const nextMailboxState = state.mailboxState || item.mailboxState;
      const nextReadState = typeof state.unread === 'boolean'
        ? (state.unread ? 'unread' : 'read')
        : item.readState;
      const mailboxChanged = nextMailboxState !== item.mailboxState;
      const readStateChanged = nextReadState !== item.readState;
      if (!mailboxChanged && !readStateChanged) continue;

      const changeDescriptions = [];
      if (mailboxChanged) changeDescriptions.push(`mailbox ${item.mailboxState} to ${nextMailboxState}`);
      if (readStateChanged) changeDescriptions.push(`read state ${item.readState} to ${nextReadState}`);
      const reason = `Gmail changed ${changeDescriptions.join(' and ')}`;

      const updated = updateEmailItemState(item.id, {
        mailboxState: nextMailboxState,
        readState: nextReadState,
        triageState: mailboxChanged
          ? (nextMailboxState === 'archived' ? 'manual_archived' : 'restored')
          : item.triageState,
        reason: mailboxChanged ? `Gmail labels changed to ${nextMailboxState}` : item.reason,
      });

      // The read_state column was added after Winnow had already accumulated a
      // sizeable local history. Hydrate those migrated `unknown` values from
      // Gmail without presenting hundreds of old messages as fresh activity.
      const isSilentReadStateHydration = !mailboxChanged
        && item.readState === 'unknown'
        && nextReadState !== 'unknown';
      if (isSilentReadStateHydration) continue;

      appendEmailEvent('mailbox.state_changed', updated, {
        source: 'gmail_sync',
        reason,
        metadata: {
          previousMailboxState: item.mailboxState,
          previousReadState: item.readState,
          mailboxState: nextMailboxState,
          readState: nextReadState,
          labels: state.labels,
        },
      });
      if (mailboxChanged) await syncSlackDeliveryForItem(updated, 'Mailbox reconciliation');
      changes.push(updated);
    } catch (err) {
      console.error(`[winnow/reconcile] Failed to reconcile ${item.account}/${item.messageId}: ${err.message}`);
    }
  }

  return { checked: items.length, changed: changes.length, changes };
}
