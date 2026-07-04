import { execFile, exec as execRaw, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { GogAdapter } from './adapters/gog.js';
import { classifyEmail } from './classify.js';
import { loadConfig, getAdapter } from './config.js';
import { loadAllRules } from './rules.js';
import { loadState, saveState, isProcessed, markProcessed, pruneOldResults, claimProcessing, releaseProcessing } from './state.js';
import { postEmailFeed } from './notify.js';
import { maybeSendPushForEmail } from './push.js';
import { appendEmailEvent, upsertEmailItemFromResult } from './store.js';

const execShellAsync = promisify(execRaw);

const execAsync = promisify(execFile);

const LABEL_MAP = {
  archived: 'winnow/archived',
  kept: 'winnow/kept',
};

const ADAPTERS = { gog: GogAdapter };

function createAdapter() {
  const name = getAdapter();
  const Cls = ADAPTERS[name];
  if (!Cls) throw new Error(`Unknown adapter: ${name}`);
  return new Cls();
}

function extractUnsubscribeLink(headers) {
  if (!headers) return null;

  let value = null;
  if (Array.isArray(headers)) {
    const h = headers.find(h => h.name?.toLowerCase() === 'list-unsubscribe');
    value = h?.value || null;
  } else if (typeof headers === 'object') {
    value = headers['list-unsubscribe'] || headers['List-Unsubscribe'] || null;
  }

  if (!value) return null;

  // Prefer HTTP(S) unsubscribe endpoints over mailto links for one-click handling.
  const httpMatch = String(value).match(/<((?:https?):\/\/[^>]+)>|((?:https?):\/\/[^,\s>]+)/i);
  if (httpMatch) return httpMatch[1] || httpMatch[2];

  const mailtoMatch = String(value).match(/<(mailto:[^>]+)>|(mailto:[^,\s>]+)/i);
  return mailtoMatch ? (mailtoMatch[1] || mailtoMatch[2]) : null;
}

async function getFullMessage(adapter, account, msg) {
  try {
    return await adapter.getMessage(account, msg.id || msg.threadId);
  } catch (err) {
    console.log(`[winnow] ⚠️ Could not fetch full message for ${msg.threadId || msg.id}: ${err.message}`);
    return null;
  }
}

function enrichMessageFromFull(msg, full) {
  if (!full) return msg;
  const headers = full.headers || msg.headers;
  return {
    ...msg,
    body: full.body || msg.body || msg.snippet || '',
    headers,
    from: headers?.from || headers?.From || msg.from,
    to: headers?.to || headers?.To || msg.to,
    subject: headers?.subject || headers?.Subject || msg.subject,
    date: headers?.date || headers?.Date || msg.date,
  };
}

async function getUnsubscribeLink(adapter, account, msg, fullMessage = null) {
  const fromSearchResult = extractUnsubscribeLink(msg.headers);
  if (fromSearchResult) return fromSearchResult;

  const fromFullMessage = fullMessage?.unsubscribe
    || extractUnsubscribeLink(fullMessage?.headers)
    || extractUnsubscribeLink(fullMessage?.message?.payload?.headers)
    || extractUnsubscribeLink(fullMessage?.payload?.headers);
  if (fromFullMessage) return fromFullMessage;

  // `gog gmail messages search` does not include List-Unsubscribe headers, but
  // `gog gmail get` exposes a normalized `unsubscribe` field. Fetch the full
  // message lazily so archived cards can show the Unsubscribe button.
  try {
    const full = await adapter.getMessage(account, msg.id || msg.threadId);
    return full?.unsubscribe
      || extractUnsubscribeLink(full?.headers)
      || extractUnsubscribeLink(full?.message?.payload?.headers)
      || extractUnsubscribeLink(full?.payload?.headers)
      || null;
  } catch (err) {
    console.log(`[winnow] ⚠️ Could not fetch unsubscribe link for ${msg.threadId || msg.id}: ${err.message}`);
    return null;
  }
}

export async function scan(account, opts = {}) {
  const config = opts.config || loadConfig();
  const adapter = opts.adapter || createAdapter();
  const classify = opts.classifyEmailFn || classifyEmail;
  const postFeed = opts.postEmailFeedFn || postEmailFeed;
  const sendPush = opts.maybeSendPushFn || maybeSendPushForEmail;
  const runHooksFn = opts.runActionHooksFn || runActionHooks;
  const searchQuery = opts.searchQuery || config.scan?.search_query || 'in:inbox is:unread newer_than:1d';
  const maxMessages = config.scan?.max_messages || 50;
  const dryRun = opts.dryRun || false;
  const skipProcessedCheck = opts.skipProcessedCheck || false;
  const shouldRunHooks = opts.runHooks ?? true;
  const shouldPostToFeed = opts.postToFeed ?? true;
  const shouldSendPush = opts.sendPush ?? true;

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
    const messageKey = msg.id || msg.threadId;
    if (!skipProcessedCheck && isProcessed(messageKey)) {
      continue;
    }
    if (!skipProcessedCheck && !claimProcessing(messageKey)) {
      continue;
    }

    try {
      console.log(`[winnow] Classifying: ${msg.subject || '(no subject)'}`);

      const fullMessage = await getFullMessage(adapter, account, msg);
      const enrichedMsg = enrichMessageFromFull(msg, fullMessage);
      const classification = await classify(enrichedMsg, { account });
      const unsubscribeLink = await getUnsubscribeLink(adapter, account, enrichedMsg, fullMessage);

      const result = {
        ...classification,
        from: enrichedMsg.from,
        subject: enrichedMsg.subject,
        snippet: enrichedMsg.snippet,
        threadId: msg.threadId,
        unsubscribeLink,
        account,
      };

      if (dryRun) {
        const action = result.archive ? 'ARCHIVE' : 'KEEP';
        console.log(`  → ${action} (${result.confidence}%) — ${result.summary}`);
      } else {
        if (result.archive) {
          // Archive + mark read + label
          await adapter.modifyLabels(account, msg.threadId, {
            add: [LABEL_MAP.archived],
            remove: ['INBOX', 'UNREAD'],
          });
        }
        // Non-archived emails: leave completely untouched in inbox

        // Ephemeral emails: local actions + auto-archive
        if (result.ephemeral) {
          if (result.extractedCode) {
            // OTP/2FA: copy code to clipboard + macOS notification
            await copyToClipboardAndNotify(result.extractedCode, result.from, result.subject);
          }
          // Ensure ephemeral emails are archived
          if (!result.archive) {
            console.log(`[winnow] Ephemeral email — auto-archiving`);
            await adapter.modifyLabels(account, msg.threadId, {
              add: [LABEL_MAP.archived],
              remove: ['INBOX', 'UNREAD'],
            });
            result.archive = true;
          }
        }

        markProcessed(messageKey, result);
        const item = upsertEmailItemFromResult(result, {
          account,
          messageId: messageKey,
          threadId: msg.threadId,
          timestamp: new Date().toISOString(),
        });
        result.emailItemId = item.id;
        result.messageId = messageKey;
        appendEmailEvent('email.scanned', item, { source: 'scan', reason: result.reason });
        appendEmailEvent(result.archive ? 'email.auto_archived' : 'email.kept', item, {
          source: 'scan',
          reason: result.reason,
          metadata: { confidence: result.confidence, ephemeral: Boolean(result.ephemeral) },
        });

        let hookResult = { suppressFeed: false, triggeredRules: [] };
        if (shouldRunHooks) {
          hookResult = await runHooksFn(enrichedMsg, result, account);
          for (const ruleId of hookResult.triggeredRules || []) {
            appendEmailEvent('email.action_hook_ran', item, {
              source: 'action_hook',
              reason: ruleId,
              metadata: { ruleId },
            });
          }
        }

        if (shouldSendPush) {
          await sendPush(item);
        }

        // Post to Slack feed (every email, regardless of action)
        if (!shouldPostToFeed) {
          console.log('[winnow] Feed posting disabled for this scan run');
        } else if (hookResult.suppressFeed) {
          console.log('[winnow] Action hook suppressed generic Slack feed for this email');
        } else {
          await postFeed(result);
        }
      }

      results.push(result);
      totalProcessed++;
    } catch (err) {
      if (!skipProcessedCheck) releaseProcessing(messageKey);
      throw err;
    }
  }

  if (!dryRun) {
    pruneOldResults();
    // Track scan time + count for health checks and daily stats
    const state = loadState();
    const now = new Date().toISOString();
    const today = now.split('T')[0];
    state.lastScanTime = now;
    if (!state.stats.daily) state.stats.daily = {};
    if (!state.stats.daily[today]) state.stats.daily[today] = {};
    if (!state.stats.daily[today].byPriority) state.stats.daily[today].byPriority = { low: 0, normal: 0, urgent: 0 };
    if (!state.stats.daily[today].rulesTriggered) state.stats.daily[today].rulesTriggered = {};
    state.stats.daily[today].processed = state.stats.daily[today].processed || 0;
    state.stats.daily[today].ephemeral = state.stats.daily[today].ephemeral || 0;
    state.stats.daily[today].bumped = state.stats.daily[today].bumped || 0;
    state.stats.daily[today].scansRun = (state.stats.daily[today].scansRun || 0) + 1;
    saveState(state);
  }

  console.log(`[winnow] Scan complete. Processed ${totalProcessed} new emails.`);
  return results;
}

/**
 * Run shell action hooks for rules that have an `action` field.
 *
 * Rule schema:
 *   - id: testflight-removal-request
 *     match: "Someone asking to be removed from TestFlight beta"
 *     trigger:              # required unless always: true; keywords that must appear in from/subject/snippet
 *       - testflight
 *       - remove
 *     action: "/path/to/script.sh"   # shell command; email metadata passed as env vars
 *     suppress_feed: true             # optional: skip generic Slack feed when hook already posts its own message
 *     archive: true
 *
 * Env vars available in the action command:
 *   WINNOW_FROM, WINNOW_SUBJECT, WINNOW_SNIPPET, WINNOW_ACCOUNT, WINNOW_THREAD_ID
 */
async function runActionHooks(msg, result, account) {
  const { rules } = loadAllRules(account);
  const actionRules = rules.filter(r => r.action);

  if (actionRules.length === 0) return { suppressFeed: false };

  const searchable = [msg.from, msg.subject, msg.snippet].join(' ').toLowerCase();
  let suppressFeed = false;
  const triggeredRules = [];

  for (const rule of actionRules) {
    // Action hooks are allowed to mutate external systems, so require an
    // explicit deterministic trigger unless the rule opts into always running.
    if (rule.trigger && rule.trigger.length > 0) {
      const allMatch = rule.trigger.every(kw => searchable.includes(kw.toLowerCase()));
      if (!allMatch) continue;
    } else if (!rule.always) {
      console.warn(`[winnow] ⚠️ Skipping action hook "${rule.id}" because it has no trigger`);
      continue;
    }

    console.log(`[winnow] 🎯 Action hook triggered: ${rule.id}`);
    const ruleRequestsSuppress = Boolean(rule.suppress_feed || rule.suppressFeed);
    triggeredRules.push(rule.id);

    const env = {
      ...process.env,
      WINNOW_FROM: msg.from || '',
      WINNOW_SUBJECT: msg.subject || '',
      WINNOW_SNIPPET: msg.snippet || '',
      WINNOW_ACCOUNT: account || '',
      WINNOW_THREAD_ID: msg.threadId || '',
      WINNOW_MESSAGE_ID: msg.id || '',
    };

    try {
      const { stdout, stderr } = await execShellAsync(rule.action, { env, timeout: 30000 });
      if (stdout) console.log(`[winnow] Action stdout:\n${stdout.trim()}`);
      if (stderr) console.log(`[winnow] Action stderr:\n${stderr.trim()}`);
      if (ruleRequestsSuppress || (stdout && /WINNOW_SUPPRESS_FEED=1/.test(stdout))) suppressFeed = true;
    } catch (err) {
      console.error(`[winnow] ⚠️ Action hook "${rule.id}" failed: ${err.message}`);
    }
  }

  return { suppressFeed, triggeredRules };
}

async function copyToClipboardAndNotify(code, from, subject) {
  try {
    // Copy code to clipboard via pbcopy (macOS), without invoking a shell.
    await new Promise((resolve, reject) => {
      const child = spawn('pbcopy');
      child.on('error', reject);
      child.on('close', (exitCode) => {
        if (exitCode === 0) resolve();
        else reject(new Error(`pbcopy exited with code ${exitCode}`));
      });
      child.stdin.end(String(code));
    });

    // Send macOS notification
    const escapeAppleScript = (value) => String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const sender = (from || '').replace(/<.*>/, '').trim();
    const title = `🔑 Code copied: ${code}`;
    const body = `From: ${sender}`;
    await execAsync('osascript', [
      '-e', `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}" sound name "Glass"`,
    ]);

    console.log(`[winnow] 📋 Code "${code}" copied to clipboard + notification sent`);
  } catch (err) {
    // Non-fatal — clipboard/notification are nice-to-have
    console.log(`[winnow] ⚠️ Could not copy to clipboard: ${err.message}`);
  }
}
