import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GogAdapter } from './adapters/gog.js';
import { classifyEmail } from './classify.js';
import { loadConfig, getAdapter } from './config.js';
import { loadState, saveState, isProcessed, markProcessed, pruneOldResults } from './state.js';
import { sendUrgentAlert, sendEphemeralFyi } from './notify.js';

const execAsync = promisify(execFile);

const LABEL_MAP = {
  low: 'winnow/low',
  normal: 'winnow/normal',
  urgent: 'winnow/urgent',
};

const ADAPTERS = { gog: GogAdapter };

function createAdapter() {
  const name = getAdapter();
  const Cls = ADAPTERS[name];
  if (!Cls) throw new Error(`Unknown adapter: ${name}`);
  return new Cls();
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
  const skipProcessedCheck = opts.skipProcessedCheck || false;

  let totalProcessed = 0;
  let results = [];

  console.log(`[winnow] Scanning ${account}...`);

  // Ensure labels exist (skip if already verified in state)
  if (!dryRun) {
    const state = loadState();
    if (!state.labelsVerified?.[account]) {
      for (const label of Object.values(LABEL_MAP)) {
        await adapter.ensureLabel(account, label);
      }
      if (!state.labelsVerified) state.labelsVerified = {};
      state.labelsVerified[account] = true;
      saveState(state);
    }
  }

  const messages = await adapter.fetchUnread(account, searchQuery, maxMessages);
  console.log(`[winnow] Found ${messages.length} unread messages`);

  for (const msg of messages) {
    if (!skipProcessedCheck && isProcessed(msg.id)) {
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

      // Ephemeral emails: notify + auto-archive
      if (result.ephemeral) {
        if (result.extractedCode) {
          // OTP/2FA: copy code to clipboard + macOS notification
          await copyToClipboardAndNotify(result.extractedCode, result.from, result.subject);
        } else {
          // FYI ephemeral: just post a quiet Slack summary
          await sendEphemeralFyi(result, account);
        }
        console.log(`[winnow] Ephemeral email — auto-archiving`);
        await adapter.modifyLabels(account, msg.threadId, {
          add: ['winnow/low'],
          remove: ['INBOX', 'UNREAD', 'winnow/urgent', 'winnow/normal'],
        });
      }

      markProcessed(msg.id, result);
    }

    results.push(result);
    totalProcessed++;
  }

  if (!dryRun) {
    pruneOldResults();
  }

  console.log(`[winnow] Scan complete. Processed ${totalProcessed} new emails.`);
  return results;
}

async function copyToClipboardAndNotify(code, from, subject) {
  try {
    // Copy code to clipboard via pbcopy (macOS)
    await execAsync('sh', ['-c', `printf '%s' "${code}" | pbcopy`]);

    // Send macOS notification
    const sender = (from || '').replace(/"/g, '\\"').replace(/<.*>/, '').trim();
    const title = `🔑 Code copied: ${code}`;
    const body = `From: ${sender}`;
    await execAsync('osascript', [
      '-e', `display notification "${body}" with title "${title}" sound name "Glass"`,
    ]);

    console.log(`[winnow] 📋 Code "${code}" copied to clipboard + notification sent`);
  } catch (err) {
    // Non-fatal — clipboard/notification are nice-to-have
    console.log(`[winnow] ⚠️ Could not copy to clipboard: ${err.message}`);
  }
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
