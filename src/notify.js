import { loadConfig, reloadConfig, getChannelForAccount } from './config.js';
import { loadState, saveState } from './state.js';

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';

function getSlackToken() {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  const config = loadConfig();
  return config.slack?.bot_token || null;
}

function getChannelId() {
  const config = loadConfig();
  return config.slack?.channel_id || null;
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

async function postToSlackAPI(text, channelOverride = null) {
  const token = getSlackToken();
  const channel = channelOverride || getChannelId();

  if (!token || !channel) {
    console.log('[winnow] No Slack bot token or channel configured — skipping notification');
    return false;
  }

  try {
    const res = await fetch(SLACK_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[winnow] Slack API error: ${data.error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[winnow] Failed to post to Slack: ${err.message}`);
    return false;
  }
}

export async function postToSlack(text) {
  return postToSlackAPI(text);
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
  return `https://mail.google.com/mail/u/0/#all/${threadId}`;
}

/**
 * Format a single email result into a Slack feed message.
 * Four states:
 *   🔑  OTP / verification code (ephemeral + extractedCode)
 *   📌  Ephemeral FYI (ephemeral, no code)
 *   🗂️  Archived (archive: true)
 *   📥  Kept in inbox (archive: false)
 */
export function formatEmailFeedMessage(result) {
  const sender = cleanSender(result.from);
  const subject = result.subject || '(no subject)';
  const link = gmailLink(result.threadId);
  const subjectDisplay = link ? `<${link}|${subject}>` : subject;

  if (result.ephemeral && result.extractedCode) {
    return `🔑 *${sender}* — ${subjectDisplay}\n_Code \`${result.extractedCode}\` copied to clipboard · auto-archived_`;
  }

  if (result.ephemeral) {
    return `📌 *${sender}* — ${subjectDisplay}\n_${result.summary} · auto-archived_`;
  }

  if (result.archive) {
    const conf = result.confidence || '?';
    return `🗂️ *${sender}* — ${subjectDisplay}\n_Archived (${conf}%): ${result.summary}_`;
  }

  // Kept in inbox
  return `📥 *${sender}* — ${subjectDisplay}`;
}

/**
 * Post a single email result to the Slack feed channel.
 * Respects: alerts mute, feed toggle (config.feed).
 * Feed is ON by default — set `feed: false` in config to disable.
 */
export async function postEmailFeed(result) {
  if (isAlertsMuted()) return false;

  const config = reloadConfig(); // re-read so toggle works without restart
  if (config.feed === false) return false;

  const text = formatEmailFeedMessage(result);
  const channel = result.account ? getChannelForAccount(result.account) : null;
  return postToSlackAPI(text, channel);
}
