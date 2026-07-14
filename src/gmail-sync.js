import { GogAdapter, normalizeGogMessage } from './adapters/gog.js';
import { scan } from './scan.js';
import { syncSlackDeliveryForItem } from './reconcile.js';
import {
  appendEmailEvent,
  findEmailItemByGmail,
  getGmailFullSyncAt,
  getGmailHistoryCursor,
  listTrackedInboxEmailItems,
  setGmailHistoryCursor,
  setGmailFullSyncAt,
  updateEmailItemState,
  upsertEmailItemFromResult,
} from './store.js';

const FULL_SYNC_LIMIT = 500;
const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

function labelsFor(message) {
  return Array.isArray(message?.labelIds) ? message.labelIds : [];
}

function mailboxStateFor(message) {
  return labelsFor(message).includes('INBOX') ? 'inbox' : 'archived';
}

function readStateFor(message) {
  return labelsFor(message).includes('UNREAD') ? 'unread' : 'read';
}

function historyIdFrom(value) {
  return String(value?.historyId || value?.HistoryId || value?.message?.historyId || value?.message?.HistoryId || '');
}

function messageTimestamp(message) {
  const milliseconds = Number(message?.internalDate);
  if (Number.isFinite(milliseconds) && milliseconds > 0) return new Date(milliseconds).toISOString();
  const parsed = new Date(message?.date || '').getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function importInboxMessage(account, message) {
  return upsertEmailItemFromResult({
    account,
    messageId: message.id,
    threadId: message.threadId,
    from: message.from,
    subject: message.subject,
    snippet: message.snippet,
    summary: '',
    action: '',
    deadline: '',
    impact: '',
    handling: 'keep',
    reason: 'Imported from the current Gmail inbox',
    confidence: null,
    archive: false,
    readState: readStateFor(message),
  }, {
    account,
    messageId: message.id,
    threadId: message.threadId,
    triageState: 'gmail_synced',
    mailboxState: 'inbox',
    readState: readStateFor(message),
    timestamp: messageTimestamp(message),
  });
}

async function applyExistingState(item, message, { source, syncSlackFn }) {
  const nextMailboxState = mailboxStateFor(message);
  const nextReadState = readStateFor(message);
  const mailboxChanged = nextMailboxState !== item.mailboxState;
  const readStateChanged = nextReadState !== item.readState;
  if (!mailboxChanged && !readStateChanged) return null;

  const updated = updateEmailItemState(item.id, {
    mailboxState: nextMailboxState,
    readState: nextReadState,
    triageState: mailboxChanged
      ? (nextMailboxState === 'archived' ? 'manual_archived' : 'restored')
      : item.triageState,
    reason: mailboxChanged ? `Gmail labels changed to ${nextMailboxState}` : item.reason,
  });

  const silentHydration = !mailboxChanged && item.readState === 'unknown';
  if (!silentHydration) {
    appendEmailEvent('mailbox.state_changed', updated, {
      source,
      reason: mailboxChanged ? `Gmail moved this message to ${nextMailboxState}` : `Gmail marked this message ${nextReadState}`,
      metadata: {
        previousMailboxState: item.mailboxState,
        previousReadState: item.readState,
        mailboxState: nextMailboxState,
        readState: nextReadState,
        labels: labelsFor(message),
      },
    });
  }
  if (mailboxChanged) await syncSlackFn(updated, 'Gmail synchronization');
  return updated;
}

async function currentHistoryId(account, adapter) {
  const latest = (await adapter.searchMailbox(account, 'in:anywhere', 1)).messages[0];
  if (!latest?.id) return '';
  return historyIdFrom(await adapter.getMessage(account, latest.id));
}

function collectHistoryChanges(data) {
  const changes = new Map();
  const records = data?.history || data?.History || [];
  const remember = (entry, flags = {}) => {
    const message = entry?.message || entry?.Message || entry;
    const id = String(message?.id || message?.Id || '');
    if (!id) return;
    changes.set(id, { ...(changes.get(id) || {}), id, ...flags });
  };

  for (const record of Array.isArray(records) ? records : []) {
    for (const entry of record.messages || record.Messages || []) remember(entry);
    for (const entry of record.messagesAdded || record.MessagesAdded || []) remember(entry, { added: true });
    for (const entry of record.messagesDeleted || record.MessagesDeleted || []) remember(entry, { deleted: true });
    for (const entry of record.labelsAdded || record.LabelsAdded || []) remember(entry, {
      inboxAdded: (entry.labelIds || entry.LabelIds || []).includes('INBOX'),
    });
    for (const entry of record.labelsRemoved || record.LabelsRemoved || []) remember(entry, {
      inboxRemoved: (entry.labelIds || entry.LabelIds || []).includes('INBOX'),
    });
  }
  return [...changes.values()];
}

export function isExpiredHistoryError(error) {
  const message = String(error?.stderr || error?.message || error || '');
  return /(?:\b404\b|startHistoryId|historyId.*(?:invalid|not found|too old)|failedPrecondition)/i.test(message);
}

export async function fullSyncGmailInbox(account, {
  adapter = new GogAdapter(),
  scanFn = scan,
  syncSlackFn = syncSlackDeliveryForItem,
} = {}) {
  // Capture the cursor before listing. Replaying a change that also appears in
  // the snapshot is harmless; capturing it afterward could skip mail arriving
  // while the full sync is in progress.
  const historyId = await currentHistoryId(account, adapter);
  const snapshot = await adapter.searchAllMailbox(account, 'in:inbox', FULL_SYNC_LIMIT);
  if (!snapshot.complete) throw new Error(`Gmail inbox snapshot was incomplete for ${account}`);

  const remoteIds = new Set(snapshot.messages.map(message => message.id));
  const changed = [];
  let imported = 0;
  const unreadToClassify = [];

  for (const item of listTrackedInboxEmailItems({ account, limit: 1000 })) {
    if (remoteIds.has(item.messageId)) continue;
    const updated = await applyExistingState(item, {
      labelIds: item.readState === 'unread' ? ['UNREAD'] : [],
    }, {
      source: 'gmail_full_sync', syncSlackFn,
    });
    if (updated) changed.push(updated);
  }

  for (const summary of snapshot.messages) {
    const existing = findEmailItemByGmail({ account, messageId: summary.id, threadId: summary.threadId });
    if (existing) {
      const updated = await applyExistingState(existing, summary, {
        source: 'gmail_full_sync', syncSlackFn,
      });
      if (updated) changed.push(updated);
      continue;
    }

    const full = normalizeGogMessage(await adapter.getMessage(account, summary.id));
    if (readStateFor(full) === 'unread') unreadToClassify.push(full);
    else {
      importInboxMessage(account, full);
      imported++;
    }
  }

  if (unreadToClassify.length) {
    await scanFn(account, {
      adapter,
      messages: unreadToClassify,
      searchQuery: 'in:inbox is:unread',
    });
  }

  if (historyId) setGmailHistoryCursor(account, historyId);
  setGmailFullSyncAt(account);
  return {
    mode: 'full',
    checked: snapshot.messages.length,
    imported,
    classified: unreadToClassify.length,
    changed: changed.length,
    historyId,
  };
}

export async function syncGmailMailbox(account, {
  adapter = new GogAdapter(),
  scanFn = scan,
  syncSlackFn = syncSlackDeliveryForItem,
} = {}) {
  const cursor = getGmailHistoryCursor(account);
  const lastFullSyncAt = new Date(getGmailFullSyncAt(account)).getTime();
  const fullSyncIsStale = !Number.isFinite(lastFullSyncAt)
    || (Date.now() - lastFullSyncAt) >= FULL_SYNC_INTERVAL_MS;
  if (!cursor || fullSyncIsStale) {
    return fullSyncGmailInbox(account, { adapter, scanFn, syncSlackFn });
  }

  let history;
  try {
    history = await adapter.getHistory(account, cursor, FULL_SYNC_LIMIT);
  } catch (error) {
    if (!isExpiredHistoryError(error)) throw error;
    return fullSyncGmailInbox(account, { adapter, scanFn, syncSlackFn });
  }

  const changed = [];
  let imported = 0;
  const unreadToClassify = [];
  for (const change of collectHistoryChanges(history)) {
    const existing = findEmailItemByGmail({ account, messageId: change.id });
    let full;
    try {
      full = normalizeGogMessage(await adapter.getMessage(account, change.id));
    } catch (error) {
      if (change.deleted || change.inboxRemoved) {
        if (existing) {
          const updated = await applyExistingState(existing, {
            labelIds: existing.readState === 'unread' ? ['UNREAD'] : [],
          }, {
            source: 'gmail_history', syncSlackFn,
          });
          if (updated) changed.push(updated);
        }
        continue;
      }
      throw error;
    }

    if (mailboxStateFor(full) === 'inbox') {
      if (existing) {
        const updated = await applyExistingState(existing, full, {
          source: 'gmail_history', syncSlackFn,
        });
        if (updated) changed.push(updated);
      } else if (readStateFor(full) === 'unread') {
        unreadToClassify.push(full);
      } else {
        importInboxMessage(account, full);
        imported++;
      }
    } else if (existing) {
      const updated = await applyExistingState(existing, full, {
        source: 'gmail_history', syncSlackFn,
      });
      if (updated) changed.push(updated);
    }
  }

  if (unreadToClassify.length) {
    await scanFn(account, {
      adapter,
      messages: unreadToClassify,
      searchQuery: 'in:inbox is:unread',
    });
  }

  const nextHistoryId = historyIdFrom(history) || cursor;
  setGmailHistoryCursor(account, nextHistoryId);
  return {
    mode: 'history',
    checked: collectHistoryChanges(history).length,
    imported,
    classified: unreadToClassify.length,
    changed: changed.length,
    historyId: nextHistoryId,
  };
}
