/**
 * slack-actions.js
 *
 * Handles Slack Block Kit button clicks (block_actions) via Socket Mode.
 * Runs alongside winnow watch — no OpenClaw dependency.
 *
 * Handles:
 *   winnow_archive    → archive email + update card to show archived state
 *   winnow_unarchive    → move email back to inbox + update card
 *   winnow_unsubscribe  → follow unsubscribe link + record tally
 *   winnow_test         → confirms routing works
 */

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { GogAdapter } from './adapters/gog.js';
import { loadConfig, getAppToken } from './config.js';
import { recordUnsubscribe } from './state.js';

let client = null;
let web = null;

function getTokens() {
  const config = loadConfig();
  const botToken = process.env.SLACK_BOT_TOKEN || config.slack?.bot_token;
  const appToken = process.env.SLACK_APP_TOKEN || getAppToken();
  return { botToken, appToken };
}

/**
 * Update a Slack message in-place — replaces buttons with a done state.
 */
async function updateMessage(channelId, ts, text, blocks = null) {
  if (!web) return;
  try {
    await web.chat.update({
      channel: channelId,
      ts,
      text,
      blocks: blocks || [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
      ],
    });
  } catch (err) {
    console.error(`[winnow/actions] Failed to update message: ${err.message}`);
  }
}

async function markMessageDone(channelId, ts, text) {
  return updateMessage(channelId, ts, text);
}

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

function archivedBlocks(text, data) {
  const buttons = [];
  if (data.threadId && data.account) {
    buttons.push(actionButton(
      'winnow_unarchive',
      'Move to Inbox',
      JSON.stringify({ threadId: data.threadId, account: data.account }),
    ));
  }
  if (data.unsubscribeLink) {
    buttons.push(actionButton(
      'winnow_unsubscribe',
      'Unsubscribe',
      JSON.stringify(data),
      'danger',
    ));
  }
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons });
  return blocks;
}

async function handleArchive(payload, action) {
  const data = JSON.parse(action.value);
  const { threadId, account } = data;
  const channelId = payload.channel?.id;
  const ts = payload.message?.ts;
  const subject = payload.message?.blocks?.[0]?.text?.text || '(email)';

  console.log(`[winnow/actions] Archive: ${threadId} (${account})`);
  try {
    const adapter = new GogAdapter();
    await adapter.archive(account, threadId);
    await adapter.markRead(account, threadId);
    await adapter.addLabel(account, threadId, 'winnow/archived');

    // Update the card to archived state, preserving the unsubscribe action when available.
    const cleanSubject = subject.replace(/📥 /g, '').replace(/\n.*/gs, '').trim();
    const text = `🗂️ ${cleanSubject}\n_Archived_`;
    await updateMessage(channelId, ts, text, archivedBlocks(text, data));
    console.log(`[winnow/actions] Archived ✓`);
  } catch (err) {
    console.error(`[winnow/actions] Archive failed: ${err.message}`);
  }
}

async function handleUnarchive(payload, action) {
  const { threadId, account } = JSON.parse(action.value);
  const channelId = payload.channel?.id;
  const ts = payload.message?.ts;
  const subject = payload.message?.blocks?.[0]?.text?.text || '(email)';

  console.log(`[winnow/actions] Move to inbox: ${threadId} (${account})`);
  try {
    const adapter = new GogAdapter();
    await adapter.unarchive(account, threadId);
    await adapter.removeLabel(account, threadId, 'winnow/archived');

    // Update the card to remove buttons and show moved state
    const cleanSubject = subject.replace(/[🗂️📌🔑] /g, '').replace(/\n.*/gs, '').trim();
    await markMessageDone(channelId, ts, `📥 ${cleanSubject}\n_Moved to inbox_`);
    console.log(`[winnow/actions] Moved to inbox ✓`);
  } catch (err) {
    console.error(`[winnow/actions] Unarchive failed: ${err.message}`);
  }
}

function absoluteUrl(url, base) {
  try { return new URL(url, base).toString(); } catch { return url; }
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function extractInputs(formHtml) {
  const params = new URLSearchParams();
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(formHtml))) {
    const tag = m[0];
    const name = tag.match(/\bname=["']?([^"'\s>]+)/i)?.[1];
    if (!name) continue;
    const value = tag.match(/\bvalue=["']?([^"'>]*)/i)?.[1] || '';
    params.set(name, value.replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  }
  return params;
}

async function followUnsubscribeLink(unsubscribeLink) {
  if (!unsubscribeLink) throw new Error('No unsubscribe link on this email');
  const url = new URL(unsubscribeLink);

  if (url.protocol === 'mailto:') {
    return { status: 'attempted', method: 'mailto', note: 'Mailto unsubscribe link; manual email required', urlHost: url.hostname };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported unsubscribe URL protocol: ${url.protocol}`);
  }

  const getRes = await fetch(url, { method: 'GET', redirect: 'follow' });
  const finalUrl = getRes.url || unsubscribeLink;
  const contentType = getRes.headers.get('content-type') || '';
  const body = contentType.includes('text/html') ? await getRes.text() : '';

  // Many List-Unsubscribe URLs complete on GET/redirect. If there is no obvious form,
  // treat a 2xx GET as success.
  const formMatch = body.match(/<form\b[\s\S]*?<\/form>/i);
  if (!formMatch) {
    if (getRes.ok) return { status: 'succeeded', method: 'one-click', note: `GET ${getRes.status}`, urlHost: new URL(finalUrl).hostname };
    throw new Error(`GET returned HTTP ${getRes.status}`);
  }

  const form = formMatch[0];
  const action = form.match(/\baction=["']([^"']+)/i)?.[1] || finalUrl;
  const method = (form.match(/\bmethod=["']?([^"'\s>]+)/i)?.[1] || 'get').toLowerCase();
  const params = extractInputs(form);
  if (![...params.keys()].some(k => /unsubscribe/i.test(k))) {
    params.set('unsubscribe', 'true');
  }

  let target = absoluteUrl(action, finalUrl);
  if (method !== 'post') {
    const u = new URL(target);
    for (const [key, value] of params) u.searchParams.set(key, value);
    target = u.toString();
  }

  const postRes = await fetch(target, {
    method: method === 'post' ? 'POST' : 'GET',
    redirect: 'follow',
    headers: method === 'post' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    body: method === 'post' ? params.toString() : undefined,
  });

  if (!postRes.ok) throw new Error(`Form submit returned HTTP ${postRes.status}`);
  return { status: 'succeeded', method: method === 'post' ? 'form' : 'link', note: `Submitted unsubscribe form (${postRes.status})`, urlHost: safeHostname(target) };
}

async function handleUnsubscribe(payload, action) {
  const data = JSON.parse(action.value);
  const channelId = payload.channel?.id;
  const ts = payload.message?.ts;
  const subjectText = payload.message?.blocks?.[0]?.text?.text || '(email)';
  const cleanSubject = subjectText.replace(/[🗂️📌🔑] /g, '').replace(/\n.*/gs, '').trim();

  console.log(`[winnow/actions] Unsubscribe: ${data.threadId || '(no thread)'} (${data.account || 'no account'})`);
  try {
    const result = await followUnsubscribeLink(data.unsubscribeLink);
    recordUnsubscribe({
      sender: data.from || cleanSubject,
      subject: data.subject || cleanSubject,
      account: data.account,
      threadId: data.threadId,
      source: 'slack-button',
      method: result.method,
      status: result.status,
      note: result.note,
      sourceMessageId: ts,
      urlHost: result.urlHost,
    });

    await markMessageDone(channelId, ts, `🚫 ${cleanSubject}\n_Unsubscribed_`);
    console.log(`[winnow/actions] Unsubscribed ✓`);
  } catch (err) {
    recordUnsubscribe({
      sender: data.from || cleanSubject,
      subject: data.subject || cleanSubject,
      account: data.account,
      threadId: data.threadId,
      source: 'slack-button',
      method: 'unknown',
      status: 'failed',
      note: err.message,
      sourceMessageId: ts,
      urlHost: data.unsubscribeLink ? safeHostname(data.unsubscribeLink) : '',
    });
    await markMessageDone(channelId, ts, `⚠️ ${cleanSubject}\n_Unsubscribe failed: ${err.message}_`);
    console.error(`[winnow/actions] Unsubscribe failed: ${err.message}`);
  }
}

/**
 * Start the Socket Mode action listener.
 * Returns the client so watch.js can shut it down cleanly.
 */
export async function startActionListener() {
  const { botToken, appToken } = getTokens();

  if (!appToken) {
    console.warn('[winnow/actions] No SLACK_APP_TOKEN — button actions disabled');
    return null;
  }
  if (!botToken) {
    console.warn('[winnow/actions] No slack bot_token — button actions disabled');
    return null;
  }

  web = new WebClient(botToken);
  client = new SocketModeClient({ appToken, logLevel: 'warn' });

  client.on('connecting', () => console.log('[winnow/actions] Socket Mode connecting...'));
  client.on('connected', () => console.log('[winnow/actions] Socket Mode connected ✓'));
  client.on('reconnecting', () => console.log('[winnow/actions] Socket Mode reconnecting...'));
  client.on('disconnected', (err) => console.log(`[winnow/actions] Socket Mode disconnected${err ? ': ' + err.message : ''}`));

  client.on('interactive', async ({ body, ack }) => {
    // Ack immediately — Slack requires <3s response
    try { await ack(); } catch (ackErr) {
      console.error(`[winnow/actions] ack() failed: ${ackErr.message}`);
    }

    if (!body || body.type !== 'block_actions') return;

    for (const action of body.actions || []) {
      try {
        if (action.action_id === 'winnow_archive') {
          await handleArchive(body, action);
        } else if (action.action_id === 'winnow_unarchive') {
          await handleUnarchive(body, action);
        } else if (action.action_id === 'winnow_unsubscribe') {
          await handleUnsubscribe(body, action);
        } else if (action.action_id === 'winnow_test') {
          const channelId = body.channel?.id;
          const ts = body.message?.ts;
          await markMessageDone(channelId, ts, '✅ Button routing works! Actions are live.');
          console.log('[winnow/actions] Test button confirmed ✓');
        }
      } catch (err) {
        console.error(`[winnow/actions] Error handling ${action.action_id}: ${err.message}`);
      }
    }
  });

  await client.start();
  console.log('[winnow/actions] Socket Mode action listener started');
  return client;
}

export async function stopActionListener() {
  if (client) {
    await client.disconnect();
    client = null;
  }
}
