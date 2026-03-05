import { GogAdapter } from './adapters/gog.js';
import { classifyEmail } from './classify.js';
import { loadConfig } from './config.js';
import { isProcessed, markProcessed } from './state.js';
import { sendUrgentAlert } from './notify.js';

const LABEL_MAP = {
  low: 'winnow/low',
  normal: 'winnow/normal',
  urgent: 'winnow/urgent',
};

function createAdapter() {
  return new GogAdapter();
}

function extractUnsubscribeLink(headers) {
  const h = headers?.find(h => h.name?.toLowerCase() === 'list-unsubscribe');
  if (!h?.value) return null;
  const match = h.value.match(/<(https?:\/\/[^>]+)>/);
  return match ? match[1] : null;
}

export async function scan(account, opts = {}) {
  const config = loadConfig();
  const adapter = createAdapter();
  const searchQuery = opts.searchQuery || config.scan?.search_query || 'in:inbox is:unread newer_than:1d';
  const maxMessages = config.scan?.max_messages || 50;
  const dryRun = opts.dryRun || false;
  const accounts = [account];

  let totalProcessed = 0;
  let results = [];

  for (const account of accounts) {
    console.log(`[winnow] Scanning ${account}...`);

    // Ensure labels exist
    if (!dryRun) {
      for (const label of Object.values(LABEL_MAP)) {
        await adapter.ensureLabel(account, label);
      }
    }

    const messages = await adapter.fetchUnread(account, searchQuery, maxMessages);
    console.log(`[winnow] Found ${messages.length} unread messages`);

    for (const msg of messages) {
      if (isProcessed(msg.id)) {
        continue;
      }

      console.log(`[winnow] Classifying: ${msg.subject || '(no subject)'}`);

      const classification = await classifyEmail(msg);
      const unsubscribeLink = extractUnsubscribeLink(msg.headers);

      const result = {
        ...classification,
        from: msg.from,
        subject: msg.subject,
        snippet: msg.snippet,
        threadId: msg.threadId,
        unsubscribeLink,
        account,
      };

      if (dryRun) {
        console.log(`  → ${result.priority.toUpperCase()} (${result.confidence}%) — ${result.summary}`);
        if (result.bumped) {
          console.log(`    ⚠️ Bumped from ${result.originalPriority} (low confidence)`);
        }
      } else {
        // Apply Gmail actions based on priority
        const label = LABEL_MAP[result.priority];
        await applyActions(adapter, account, msg.threadId, result.priority, label);

        // Send urgent alert immediately
        if (result.priority === 'urgent') {
          await sendUrgentAlert(result, account);
        }

        markProcessed(msg.id, result);
      }

      results.push(result);
      totalProcessed++;
    }
  }

  console.log(`[winnow] Scan complete. Processed ${totalProcessed} new emails.`);
  return results;
}

async function applyActions(adapter, account, threadId, priority, label) {
  switch (priority) {
    case 'low':
      // Archive + mark read + label
      await adapter.modifyLabels(account, threadId, {
        add: [label],
        remove: ['INBOX', 'UNREAD'],
      });
      break;

    case 'normal':
      // Mark read + label (keep in inbox)
      await adapter.modifyLabels(account, threadId, {
        add: [label],
        remove: ['UNREAD'],
      });
      break;

    case 'urgent':
      // Just label (keep in inbox, keep unread)
      await adapter.addLabel(account, threadId, label);
      break;
  }
}
