import { reloadConfig, getSlackRoutingForAccount } from './config.js';
import { loadState, saveState } from './state.js';
import { appendEmailEvent, listDeliveryRecords, makeEmailItemId, recordDelivery } from './store.js';

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';

function getSlackToken(account = '') {
  return getSlackRoutingForAccount(account).botToken;
}

function getChannelId(account = '') {
  return getSlackRoutingForAccount(account).channelId;
}

// ── Alert muting ──────────────────────────────────────────────

export function isAlertsMuted() {
  const state = loadState();
  if (!state.alertsMuted) return false;
  if (state.alertsMutedUntil) {
    if (new Date(state.alertsMutedUntil) < new Date()) {
      state.alertsMuted = false;
      state.alertsMutedUntil = null;
      saveState(state);
      return false;
    }
  }
  return true;
}

export function muteAlerts(durationMinutes = null) {
  const state = loadState();
  state.alertsMuted = true;
  state.alertsMutedUntil = durationMinutes
    ? new Date(Date.now() + durationMinutes * 60000).toISOString()
    : null;
  saveState(state);
}

export function unmuteAlerts() {
  const state = loadState();
  state.alertsMuted = false;
  state.alertsMutedUntil = null;
  saveState(state);
}

export function getAlertStatus() {
  const state = loadState();
  if (!state.alertsMuted) return { muted: false };
  if (state.alertsMutedUntil) {
    const until = new Date(state.alertsMutedUntil);
    if (until < new Date()) return { muted: false };
    return { muted: true, until: state.alertsMutedUntil };
  }
  return { muted: true, until: null };
}

// ── Low-level Slack poster ────────────────────────────────────

/**
 * Post a message to Slack.
 * @param {string} text - Fallback text (required by Slack, shown in notifications)
 * @param {string|null} channelOverride - Channel ID override
 * @param {string|null} threadTs - Thread timestamp for replies
 * @param {Array|null} blocks - Block Kit blocks for rich formatting
 * @returns {{ ok: boolean, ts?: string, channelId?: string }}
 */
async function postToSlackAPI(text, channelOverride = null, threadTs = null, blocks = null, account = '') {
  const token = getSlackToken(account);
  const channel = channelOverride || getChannelId(account);

  if (!token || !channel) {
    console.log('[winnow] No Slack bot token or channel configured — skipping notification');
    return { ok: false };
  }

  try {
    const body = { channel, text, unfurl_links: false, unfurl_media: false };
    if (threadTs) body.thread_ts = threadTs;
    if (blocks) body.blocks = blocks;

    const res = await fetch(SLACK_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[winnow] Slack API error: ${data.error}`);
      return { ok: false };
    }
    return { ok: true, ts: data.ts, channelId: data.channel || channel };
  } catch (err) {
    console.error(`[winnow] Failed to post to Slack: ${err.message}`);
    return { ok: false };
  }
}

/**
 * Update an existing Slack message in-place (e.g. after Archive button is clicked).
 * @param {string} ts - Message timestamp
 * @param {string} channelId - Channel ID
 * @param {string} text - New fallback text
 * @param {Array|null} blocks - New Block Kit blocks
 */
export async function updateSlackMessage(ts, channelId, text, blocks = null, account = '') {
  const token = getSlackToken(account);
  if (!token) return { ok: false };

  try {
    const body = { channel: channelId, ts, text, unfurl_links: false, unfurl_media: false };
    if (blocks) body.blocks = blocks;

    const res = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[winnow] Slack update error: ${data.error}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[winnow] Failed to update Slack message: ${err.message}`);
    return { ok: false };
  }
}

export async function postToSlack(text) {
  const result = await postToSlackAPI(text);
  return result.ok;
}

// ── Email feed ────────────────────────────────────────────────

function cleanSender(from) {
  if (!from) return 'Unknown';
  const match = from.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  const emailMatch = from.match(/([^@]+)@/);
  if (emailMatch) return emailMatch[1];
  return from.slice(0, 30);
}

function gmailLink(threadId) {
  if (!threadId) return null;
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function escapeSlackText(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[*_`~]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function escapeSlackLinkLabel(str) {
  return escapeSlackText(str).replace(/\|/g, '¦');
}

/**
 * Escape Slack mrkdwn special characters in model-generated strings
 * (summary, reason) so a crafted email can't inject formatting or links.
 */
function escapeModelText(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Strip Slack mrkdwn formatting injected by model output
    .replace(/[*_`~]/g, '')
    // Remove any URL-like patterns (prevent link injection)
    .replace(/https?:\/\/\S+/g, '[url removed]')
    // Collapse to single line — no newline tricks
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function isEmptyTriageValue(value, emptyValues) {
  const normalized = escapeModelText(value).toLowerCase();
  return !normalized || emptyValues.some(v => normalized === v || normalized.startsWith(`${v} `));
}

function buildTriageText(result, { compact = false } = {}) {
  const lines = [];
  const summary = escapeModelText(result.summary);
  if (summary) lines.push(summary);

  const action = escapeModelText(result.action);
  const deadline = escapeModelText(result.deadline);
  const impact = escapeModelText(result.impact);
  const handling = escapeModelText(result.handling);

  const hasAction = !isEmptyTriageValue(action, ['no action needed', 'none found']);
  const hasDeadline = !isEmptyTriageValue(deadline, ['no deadline found', 'none found']);
  const hasImpact = !isEmptyTriageValue(impact, ['none found', 'no impact found']);

  if (!compact || hasAction) lines.push(`*Action:* ${action || 'Review email manually'}`);
  if (!compact || hasDeadline) lines.push(`*Due:* ${deadline || 'No deadline found'}`);
  if (!compact || hasImpact) lines.push(`*Impact:* ${impact || 'None found'}`);
  if (!compact && handling) lines.push(`*Handle:* ${handling}`);

  return lines.join('\n');
}

/**
 * Build a compact single-button actions block.
 * @param {string} actionId - The action_id for the button
 * @param {string} label - Button label text
 * @param {string} value - JSON-encoded value payload
 * @param {'primary'|'danger'|undefined} style
 */
function actionButton(actionId, label, value, style) {
  const btn = {
    type: 'button',
    text: { type: 'plain_text', text: label, emoji: false },
    action_id: actionId,
    value,
  };
  if (style) btn.style = style;
  return btn;
}

function actionBlock(buttons) {
  return { type: 'actions', elements: buttons };
}

function actionPayload(result, keys) {
  const payload = {};
  for (const key of keys) {
    if (result[key]) payload[key] = result[key];
  }
  return JSON.stringify(payload);
}

/**
 * Build Block Kit blocks for a kept-inbox email.
 * Subject is already a Gmail link — one compact Archive button, no redundant Open button.
 */
function buildInboxBlocks(result) {
  const sender = escapeSlackText(cleanSender(result.from));
  const subject = result.subject || '(no subject)';
  const link = gmailLink(result.threadId);
  const subjectDisplay = link ? `<${link}|${escapeSlackLinkLabel(subject)}>` : escapeSlackText(subject);
  const triageText = buildTriageText(result);

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `📥 *${sender}* — ${subjectDisplay}\n${triageText}` },
    },
  ];

  if (result.threadId && result.account) {
    blocks.push(actionBlock([
      actionButton(
        'winnow_archive',
        'Archive',
        actionPayload(result, ['emailItemId', 'threadId', 'account']),
        'danger',
      ),
    ]));
  }

  return blocks;
}

/**
 * Build Block Kit blocks for an archived or ephemeral email.
 * Includes Move to Inbox, plus Unsubscribe when the email exposes an unsubscribe link.
 */
function buildArchivedBlocks(text, result) {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text } },
  ];

  const buttons = [];
  if (result.threadId && result.account) {
    buttons.push(actionButton(
      'winnow_unarchive',
      'Move to Inbox',
      actionPayload(result, ['emailItemId', 'threadId', 'account']),
    ));
  }

  if (result.unsubscribeLink) {
    const payloadKeys = result.emailItemId
      ? ['emailItemId', 'threadId', 'account']
      : ['threadId', 'account', 'unsubscribeLink', 'from', 'subject'];
    buttons.push(actionButton(
      'winnow_unsubscribe',
      'Unsubscribe',
      actionPayload(result, payloadKeys),
      'danger',
    ));
  }

  if (buttons.length) blocks.push(actionBlock(buttons));

  return blocks;
}

/**
 * Format a single email result into a Slack feed message.
 * Returns { text, blocks } — blocks is null for simple messages.
 * Four states:
 *   🔑  OTP / verification code (ephemeral + extractedCode)
 *   📌  Ephemeral FYI (ephemeral, no code)
 *   🗂️  Archived (archive: true)
 *   📥  Kept in inbox (archive: false) — rich Block Kit with summary + buttons
 */
export function formatEmailFeedMessage(result) {
  const sender = escapeSlackText(cleanSender(result.from));
  const subject = result.subject || '(no subject)';
  const link = gmailLink(result.threadId);
  const subjectDisplay = link ? `<${link}|${escapeSlackLinkLabel(subject)}>` : escapeSlackText(subject);
  const triageText = buildTriageText(result, { compact: true });
  const code = escapeSlackText(result.extractedCode);

  if (result.ephemeral && code) {
    const t = `🔑 *${sender}* — ${subjectDisplay} — Code \`${code}\` (auto-archived)`;
    return { text: t, blocks: buildArchivedBlocks(t, result) };
  }

  if (result.ephemeral) {
    const t = `📌 *${sender}* — ${subjectDisplay}\n${triageText}`;
    return { text: t, blocks: buildArchivedBlocks(t, result) };
  }

  if (result.archive) {
    const t = `🗂️ *${sender}* — ${subjectDisplay}\n${triageText}`;
    return { text: t, blocks: buildArchivedBlocks(t, result) };
  }

  // Kept in inbox — Block Kit card with summary inline + Archive button
  return {
    text: `📥 *${sender}* — ${escapeSlackText(subject)}: ${triageText.replace(/\n/g, ' · ')}`, // fallback for push notifications
    blocks: buildInboxBlocks(result),
  };
}

/**
 * Post a single email result to the Slack feed channel.
 * Respects: alerts mute, feed toggle (config.feed).
 * Feed is ON by default — set `feed: false` in config to disable.
 */
export async function postEmailFeed(result) {
  if (isAlertsMuted()) return false;

  const emailItemId = result.emailItemId || makeEmailItemId(result.account, result.messageId, result.threadId);
  const existingDelivery = listDeliveryRecords(emailItemId, 'slack')
    .find(delivery => delivery.deliveryState === 'sent' && delivery.messageTs);
  if (existingDelivery) {
    console.log(`[winnow] Slack feed already posted for ${result.threadId || result.messageId || emailItemId} — skipping duplicate`);
    return true;
  }

  const config = reloadConfig(); // re-read so toggle works without restart
  if (config.feed === false) return false;
  const feedMode = config.slack?.feed_mode || 'all';
  if (feedMode === 'off') return false;
  if (feedMode === 'kept' && result.archive) return false;

  const { text, blocks } = formatEmailFeedMessage(result);
  const channel = result.account ? getChannelId(result.account) : null;
  const posted = await postToSlackAPI(text, channel, null, blocks, result.account || '');
  if (posted.ok) {
    const delivery = recordDelivery({
      emailItemId,
      sink: 'slack',
      channelId: posted.channelId || channel || '',
      messageTs: posted.ts,
      deliveryState: 'sent',
      metadata: { feedMode },
    });
    appendEmailEvent('delivery.slack_posted', { id: emailItemId, account: result.account, messageId: result.messageId, threadId: result.threadId }, {
      source: 'slack',
      reason: 'Posted email feed card',
      metadata: { deliveryId: delivery.id, channelId: posted.channelId || channel || '', messageTs: posted.ts },
    });
  }

  return posted.ok;
}
