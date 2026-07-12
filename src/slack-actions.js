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
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getSlackActionRoutings } from './config.js';
import { findUnsubscribeBySourceMessageId, recordUnsubscribe } from './state.js';
import { archiveEmail, moveEmailToInbox } from './actions.js';
import { formatEmailFeedMessage } from './notify.js';
import { getEmailItem } from './store.js';

let clients = [];
const UNSUBSCRIBE_TIMEOUT_MS = 10000;
const MAX_UNSUBSCRIBE_REDIRECTS = 5;
const UNSUBSCRIBE_USER_AGENT = 'Winnow unsubscribe bot (+https://github.com/cameronehrlich/winnow)';

/**
 * Update a Slack message in-place — replaces buttons with a done state.
 */
async function updateMessage(web, channelId, ts, text, blocks = null) {
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

async function markMessageDone(web, channelId, ts, text) {
  return updateMessage(web, channelId, ts, text);
}

function itemToSlackResult(item) {
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

async function updateMessageFromItem(web, channelId, ts, item) {
  if (!item) return;
  const { text, blocks } = formatEmailFeedMessage(itemToSlackResult(item));
  await updateMessage(web, channelId, ts, text, blocks);
}

function resolveActionEmailData(data) {
  const item = data.emailItemId ? getEmailItem(data.emailItemId) : null;
  return {
    ...data,
    account: data.account || item?.account || '',
    threadId: data.threadId || item?.threadId || '',
    messageId: data.messageId || item?.messageId || '',
    from: data.from || item?.from || '',
    subject: data.subject || item?.subject || '',
    unsubscribeLink: data.unsubscribeLink || item?.unsubscribeLink || '',
    item,
  };
}

async function handleArchive(web, payload, action) {
  const data = resolveActionEmailData(JSON.parse(action.value));
  const { threadId, account } = data;
  const channelId = payload.channel?.id;
  const ts = payload.message?.ts;

  console.log(`[winnow/actions] Archive: ${threadId} (${account})`);
  try {
    const updated = await archiveEmail({
      account,
      threadId,
      messageId: data.messageId,
      emailItemId: data.emailItemId,
      source: 'slack',
      syncSlack: false,
      from: data.from,
      subject: data.subject,
      reason: 'Slack Archive button',
    });

    await updateMessageFromItem(web, channelId, ts, updated);
    console.log(`[winnow/actions] Archived ✓`);
  } catch (err) {
    console.error(`[winnow/actions] Archive failed: ${err.message}`);
  }
}

async function handleUnarchive(web, payload, action) {
  const data = resolveActionEmailData(JSON.parse(action.value));
  const { threadId, account } = data;
  const channelId = payload.channel?.id;
  const ts = payload.message?.ts;

  console.log(`[winnow/actions] Move to inbox: ${threadId} (${account})`);
  try {
    const updated = await moveEmailToInbox({
      account,
      threadId,
      messageId: data.messageId,
      emailItemId: data.emailItemId,
      source: 'slack',
      syncSlack: false,
      reason: 'Slack Move to Inbox button',
    });

    await updateMessageFromItem(web, channelId, ts, updated);
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

function normalizedHostname(url) {
  return String(url.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0;
}

function isPrivateIpv6(address) {
  const value = address.toLowerCase();
  if (value === '::1' || value === '::') return true;
  const firstHextet = Number.parseInt(value.split(':')[0], 16);
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (/^[0-9a-f]+:[0-9a-f]+$/i.test(mapped)) {
      const [high, low] = mapped.split(':').map(part => Number.parseInt(part, 16));
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return isPrivateIpv4([
          (high >> 8) & 255,
          high & 255,
          (low >> 8) & 255,
          low & 255,
        ].join('.'));
      }
    }
    return isPrivateIpv4(mapped);
  }
  return false;
}

function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return false;
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === 'local'
    || host.endsWith('.local');
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map(cookie => cookie.trim()).filter(Boolean);
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  return splitSetCookieHeader(headers.get('set-cookie'));
}

class UnsubscribeCookieJar {
  constructor() {
    this.cookies = new Map();
  }

  storeFromResponse(url, headers) {
    const host = normalizedHostname(new URL(url));
    for (const header of getSetCookieHeaders(headers)) {
      const [pair] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      this.cookies.set(`${host}\t${name}`, { host, name, value });
    }
  }

  headerFor(url) {
    const host = normalizedHostname(new URL(url));
    const pairs = [];
    for (const cookie of this.cookies.values()) {
      if (cookie.host === host || host.endsWith(`.${cookie.host}`)) {
        pairs.push(`${cookie.name}=${cookie.value}`);
      }
    }
    return pairs.join('; ');
  }
}

export async function validateUnsubscribeUrl(unsubscribeLink) {
  const url = new URL(unsubscribeLink);
  if (url.protocol === 'mailto:') return url;
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported unsubscribe URL protocol: ${url.protocol}`);
  }

  const hostname = normalizedHostname(url);
  if (!hostname || isBlockedHostname(hostname) || isPrivateAddress(hostname)) {
    throw new Error('Blocked unsafe unsubscribe URL host');
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('Blocked unsafe unsubscribe URL address');
  }

  return url;
}

async function safeFetch(urlLike, opts = {}, redirectsRemaining = MAX_UNSUBSCRIBE_REDIRECTS, cookieJar = null) {
  const url = await validateUnsubscribeUrl(urlLike);
  if (url.protocol === 'mailto:') {
    throw new Error('Unsupported unsubscribe redirect protocol: mailto:');
  }
  const headers = new Headers(opts.headers || {});
  if (!headers.has('Accept')) headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  if (!headers.has('User-Agent')) headers.set('User-Agent', UNSUBSCRIBE_USER_AGENT);
  const cookieHeader = cookieJar?.headerFor(url.toString());
  if (cookieHeader && !headers.has('Cookie')) headers.set('Cookie', cookieHeader);

  const res = await fetch(url, {
    ...opts,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(UNSUBSCRIBE_TIMEOUT_MS),
  });
  cookieJar?.storeFromResponse(url.toString(), res.headers);

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) return res;
    if (redirectsRemaining <= 0) throw new Error('Too many unsubscribe redirects');

    const nextUrl = absoluteUrl(location, url.toString());
    const nextOpts = { ...opts };
    if ([301, 302, 303].includes(res.status)) {
      nextOpts.method = 'GET';
      delete nextOpts.body;
      delete nextOpts.headers;
    }
    return safeFetch(nextUrl, nextOpts, redirectsRemaining - 1, cookieJar);
  }

  return res;
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

export async function followUnsubscribeLink(unsubscribeLink) {
  if (!unsubscribeLink) throw new Error('No unsubscribe link on this email');
  const url = await validateUnsubscribeUrl(unsubscribeLink);

  if (url.protocol === 'mailto:') {
    return { status: 'attempted', method: 'mailto', note: 'Mailto unsubscribe link; manual email required', urlHost: url.hostname };
  }

  const cookieJar = new UnsubscribeCookieJar();
  const getRes = await safeFetch(url, { method: 'GET' }, MAX_UNSUBSCRIBE_REDIRECTS, cookieJar);
  const finalUrl = getRes.url || unsubscribeLink;
  const contentType = getRes.headers.get('content-type') || '';
  const body = contentType.includes('text/html') ? await getRes.text() : '';

  // Many List-Unsubscribe URLs complete on GET/redirect. If there is no obvious form,
  // treat a 2xx GET as success.
  const formMatch = body.match(/<form\b[\s\S]*?<\/form>/i);
  if (!formMatch) {
    if (getRes.ok) return { status: 'succeeded', method: 'one-click', note: `GET ${getRes.status}`, urlHost: new URL(finalUrl).hostname };
    if (getRes.status === 405) {
      const postRes = await safeFetch(finalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      }, MAX_UNSUBSCRIBE_REDIRECTS, cookieJar);
      if (postRes.ok) {
        return {
          status: 'succeeded',
          method: 'one-click',
          note: `POST List-Unsubscribe=One-Click returned HTTP ${postRes.status}`,
          urlHost: new URL(postRes.url || finalUrl).hostname,
        };
      }
      throw new Error(`One-click POST returned HTTP ${postRes.status}`);
    }
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

  const headers = method === 'post'
    ? {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': new URL(target).origin,
        'Referer': finalUrl,
      }
    : { 'Referer': finalUrl };

  const postRes = await safeFetch(target, {
    method: method === 'post' ? 'POST' : 'GET',
    headers,
    body: method === 'post' ? params.toString() : undefined,
  }, MAX_UNSUBSCRIBE_REDIRECTS, cookieJar);

  if (!postRes.ok) throw new Error(`Form submit returned HTTP ${postRes.status}`);
  return { status: 'succeeded', method: method === 'post' ? 'form' : 'link', note: `Submitted unsubscribe form (${postRes.status})`, urlHost: safeHostname(target) };
}

async function handleUnsubscribe(web, payload, action) {
  const data = resolveActionEmailData(JSON.parse(action.value));
  const channelId = payload.channel?.id;
  const ts = payload.message?.ts;
  const subjectText = payload.message?.blocks?.[0]?.text?.text || '(email)';
  const cleanSubject = subjectText.replace(/[🗂️📌🔑] /g, '').replace(/\n.*/gs, '').trim();

  console.log(`[winnow/actions] Unsubscribe: ${data.threadId || '(no thread)'} (${data.account || 'no account'})`);
  try {
    const existing = findUnsubscribeBySourceMessageId(ts);
    if (existing && existing.status !== 'failed') {
      await markMessageDone(web, channelId, ts, `🚫 ${cleanSubject}\n_Already unsubscribed_`);
      console.log('[winnow/actions] Unsubscribe already recorded for this Slack card; skipping duplicate request');
      return;
    }

    if (!data.unsubscribeLink) throw new Error('No unsubscribe link on this email');
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

    const statusText = result.status === 'attempted'
      ? '_Manual unsubscribe required_'
      : '_Unsubscribed_';
    await markMessageDone(web, channelId, ts, `🚫 ${cleanSubject}\n${statusText}`);
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
    await markMessageDone(web, channelId, ts, `⚠️ ${cleanSubject}\n_Unsubscribe failed: ${err.message}_`);
    console.error(`[winnow/actions] Unsubscribe failed: ${err.message}`);
  }
}

/**
 * Start the Socket Mode action listener.
 * Returns the clients so watch.js can shut them down cleanly.
 */
export async function startActionListener() {
  const routes = getSlackActionRoutings();

  if (!routes.length) {
    console.warn('[winnow/actions] No Slack app+bot token pair configured — button actions disabled');
    return [];
  }

  clients = [];
  for (const route of routes) {
    const web = new WebClient(route.botToken);
    const client = new SocketModeClient({ appToken: route.appToken, logLevel: 'error' });
    const label = route.account || 'default';

    client.on('connecting', () => console.log(`[winnow/actions] Socket Mode connecting (${label})...`));
    client.on('connected', () => console.log(`[winnow/actions] Socket Mode connected (${label}) ✓`));
    client.on('reconnecting', () => console.log(`[winnow/actions] Socket Mode reconnecting (${label})...`));
    client.on('disconnected', (err) => console.log(`[winnow/actions] Socket Mode disconnected (${label})${err ? ': ' + err.message : ''}`));

    client.on('interactive', async ({ body, ack }) => {
      // Ack immediately — Slack requires <3s response
      try { await ack(); } catch (ackErr) {
        console.error(`[winnow/actions] ack() failed (${label}): ${ackErr.message}`);
      }

      if (!body || body.type !== 'block_actions') return;

      for (const action of body.actions || []) {
        try {
          if (action.action_id === 'winnow_archive') {
            await handleArchive(web, body, action);
          } else if (action.action_id === 'winnow_unarchive') {
            await handleUnarchive(web, body, action);
          } else if (action.action_id === 'winnow_unsubscribe') {
            await handleUnsubscribe(web, body, action);
          } else if (action.action_id === 'winnow_test') {
            const channelId = body.channel?.id;
            const ts = body.message?.ts;
            await markMessageDone(web, channelId, ts, '✅ Button routing works! Actions are live.');
            console.log(`[winnow/actions] Test button confirmed (${label}) ✓`);
          }
        } catch (err) {
          console.error(`[winnow/actions] Error handling ${action.action_id} (${label}): ${err.message}`);
        }
      }
    });

    await client.start();
    clients.push(client);
  }

  console.log(`[winnow/actions] Socket Mode action listener started for ${clients.length} Slack app${clients.length === 1 ? '' : 's'}`);
  return clients;
}

export async function stopActionListener() {
  for (const client of clients) {
    await client.disconnect();
  }
  clients = [];
}
