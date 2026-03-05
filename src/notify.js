import { loadConfig } from './config.js';
import { loadState, saveState } from './state.js';

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';

function getSlackToken() {
  // Check env var first, then config
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  const config = loadConfig();
  return config.slack?.bot_token || null;
}

function getChannelId() {
  const config = loadConfig();
  return config.slack?.channel_id || null;
}

export function isAlertsMuted() {
  const state = loadState();
  if (!state.alertsMuted) return false;
  // Check temporary mute expiry
  if (state.alertsMutedUntil) {
    if (new Date(state.alertsMutedUntil) < new Date()) {
      // Mute expired — auto-unmute
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
  if (durationMinutes) {
    state.alertsMutedUntil = new Date(Date.now() + durationMinutes * 60000).toISOString();
  } else {
    state.alertsMutedUntil = null; // permanent until manually turned on
  }
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

async function postToSlackAPI(text) {
  const token = getSlackToken();
  const channel = getChannelId();

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

export async function sendUrgentAlert(result, account) {
  if (isAlertsMuted()) {
    console.log('[winnow] Alerts muted — skipping urgent notification');
    return false;
  }

  const emoji = '🔴';
  const confidence = result.bumped
    ? `⚠️ ${result.confidence}% confidence (bumped from ${result.originalPriority})`
    : `${result.confidence}% confidence`;

  const text = [
    `${emoji} *Urgent Email* — ${account}`,
    `*From:* ${result.from}`,
    `*Subject:* ${result.subject}`,
    `*Summary:* ${result.summary}`,
    `_${confidence}_`,
    '',
    `💡 Reply here to adjust: _"make emails like this normal/low"_`,
  ].join('\n');

  return postToSlackAPI(text);
}
