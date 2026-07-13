import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig, getAccounts } from './config.js';
import { archiveEmail, markEmailRead, markEmailUnread, moveEmailToInbox } from './actions.js';
import { scan } from './scan.js';
import { findUnsubscribeForEmail, getUnsubscribes, recordUnsubscribe } from './state.js';
import { followUnsubscribeLink } from './slack-actions.js';
import { handleMcpMessage } from './mcp.js';
import { getRuntimeStatus, listAccountStatus } from './status.js';
import { getPushCapabilities } from './push.js';
import {
  deletePushDevice,
  ensureStore,
  getDailyActionSummary,
  getLifetimeActionSummary,
  getEmailItem,
  listEmailItems,
  listEvents,
  registerPushDevice,
  storeEvents,
} from './store.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const EMAIL_STATES = ['all', 'inbox', 'archived'];
const EMAIL_ACTIONS = ['archive', 'move-to-inbox', 'mark-read', 'mark-unread', 'unsubscribe'];

class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function sendNoContent(res) {
  res.writeHead(202);
  res.end();
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, 'request_body_too_large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

async function readJsonObject(req) {
  const value = await readJson(req);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new HttpError(400, 'invalid_json_body', 'JSON body must be an object');
  }
  return value;
}

function getToken() {
  return process.env.WINNOW_API_TOKEN || loadConfig().api?.token || '';
}

function secureEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requireAuth(req, res) {
  const token = getToken();
  if (!token) {
    sendJson(res, 503, { error: 'api_token_not_configured' });
    return false;
  }
  const header = req.headers.authorization || '';
  if (!secureEqual(header, `Bearer ${token}`)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

function route(pathname, pattern) {
  const names = [];
  const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, (part) => {
    names.push(part.slice(1));
    return '([^/]+)';
  })}$`);
  const match = pathname.match(regex);
  if (!match) return null;
  try {
    return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
  } catch {
    throw new HttpError(400, 'invalid_path_parameter');
  }
}

function queryInteger(url, name, { fallback, min, max }) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `invalid_${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, `invalid_${name}`);
  }
  return value;
}

function bodyBoolean(body, name, fallback) {
  if (body[name] === undefined) return fallback;
  if (typeof body[name] !== 'boolean') throw new HttpError(400, `invalid_${name}`);
  return body[name];
}

function queryEmailState(url) {
  const state = url.searchParams.get('state') || 'all';
  if (!EMAIL_STATES.includes(state)) throw new HttpError(400, 'invalid_state');
  return state;
}

function queryCursor(url) {
  const cursor = url.searchParams.get('cursor') || '';
  if (cursor && Number.isNaN(Date.parse(cursor))) throw new HttpError(400, 'invalid_cursor');
  return cursor;
}

function queryDate(url) {
  const date = url.searchParams.get('date') || '';
  if (!date) return undefined;
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new HttpError(400, 'invalid_date');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, 'invalid_date');
  }
  return date;
}

function unsubscribeEntryFor(item, entries = getUnsubscribes().entries || []) {
  if (!item) return null;
  return entries.find(entry => (
    entry.account === item.account
    && entry.threadId === item.threadId
    && (!entry.sender || entry.sender === item.from)
  )) || null;
}

function mobileEmailItem(item, entries) {
  if (!item) return item;
  const entry = unsubscribeEntryFor(item, entries);
  return {
    ...item,
    unsubscribeState: entry?.status || (item.unsubscribeLink ? 'available' : 'unavailable'),
  };
}

async function handleAuthed(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/v1/bootstrap') {
    const accounts = listAccountStatus();
    sendJson(res, 200, {
      apiVersion: 1,
      serverTime: new Date().toISOString(),
      defaultAccount: accounts[0]?.email || null,
      accounts,
      defaults: {
        emailState: 'all',
        pageSize: 50,
      },
      capabilities: {
        emailStates: EMAIL_STATES,
        emailActions: EMAIL_ACTIONS,
        eventPolling: true,
        eventStream: true,
        dailySummary: true,
        lifetimeSummary: true,
        manualScan: true,
        push: getPushCapabilities(),
      },
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/status') {
    sendJson(res, 200, getRuntimeStatus());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/accounts') {
    sendJson(res, 200, {
      accounts: listAccountStatus(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/emails') {
    const page = listEmailItems({
      state: queryEmailState(url),
      account: url.searchParams.get('account') || '',
      cursor: queryCursor(url),
      limit: queryInteger(url, 'limit', { fallback: 50, min: 1, max: 200 }),
    });
    const unsubscribeEntries = getUnsubscribes().entries || [];
    sendJson(res, 200, {
      ...page,
      items: page.items.map(item => mobileEmailItem(item, unsubscribeEntries)),
    });
    return;
  }

  const emailMatch = route(url.pathname, '/v1/emails/:id');
  if (req.method === 'GET' && emailMatch) {
    const item = getEmailItem(emailMatch.id);
    if (!item) sendJson(res, 404, { error: 'email_not_found' });
    else sendJson(res, 200, { item: mobileEmailItem(item) });
    return;
  }

  for (const [suffix, handler] of [
    ['archive', archiveEmail],
    ['move-to-inbox', moveEmailToInbox],
    ['mark-read', markEmailRead],
    ['mark-unread', markEmailUnread],
  ]) {
    const match = route(url.pathname, `/v1/emails/:id/${suffix}`);
    if (req.method === 'POST' && match) {
      const item = getEmailItem(match.id);
      if (!item) {
        sendJson(res, 404, { error: 'email_not_found' });
        return;
      }
      try {
        const updated = await handler({
          emailItemId: item.id,
          account: item.account,
          threadId: item.threadId,
          messageId: item.messageId,
          source: 'api',
          reason: `API ${suffix}`,
        });
        sendJson(res, 200, {
          ok: true,
          action: suffix,
          item: mobileEmailItem(getEmailItem(item.id) || updated || item),
        });
      } catch (err) {
        console.error(`[winnow/api] ${suffix} failed for ${item.id}: ${err.message}`);
        sendJson(res, 502, {
          ok: false,
          error: 'email_action_failed',
          action: suffix,
          item: mobileEmailItem(getEmailItem(item.id) || item),
        });
      }
      return;
    }
  }

  const unsubscribeMatch = route(url.pathname, '/v1/emails/:id/unsubscribe');
  if (req.method === 'POST' && unsubscribeMatch) {
    const item = getEmailItem(unsubscribeMatch.id);
    if (!item) {
      sendJson(res, 404, { error: 'email_not_found' });
    } else if (!item.unsubscribeLink) {
      sendJson(res, 400, { error: 'unsubscribe_link_missing', item: mobileEmailItem(item) });
    } else {
      const previous = findUnsubscribeForEmail({
        account: item.account,
        threadId: item.threadId,
        sender: item.from,
      });
      if (previous && ['succeeded', 'attempted'].includes(previous.status)) {
        sendJson(res, 200, {
          ok: previous.status === 'succeeded',
          action: 'unsubscribe',
          outcome: previous.status,
          requiresManualAction: previous.status === 'attempted',
          deduplicated: true,
          item: mobileEmailItem(item),
          entry: previous,
        });
        return;
      }
      try {
        const result = await followUnsubscribeLink(item.unsubscribeLink);
        const entry = recordUnsubscribe({
          sender: item.from,
          subject: item.subject,
          account: item.account,
          threadId: item.threadId,
          source: 'api',
          method: result.method,
          status: result.status,
          note: result.note,
          urlHost: result.urlHost,
        });
        sendJson(res, 200, {
          ok: result.status === 'succeeded',
          action: 'unsubscribe',
          outcome: result.status,
          requiresManualAction: result.status === 'attempted',
          item: mobileEmailItem(getEmailItem(item.id) || item),
          entry,
        });
      } catch (err) {
        const entry = recordUnsubscribe({
          sender: item.from,
          subject: item.subject,
          account: item.account,
          threadId: item.threadId,
          source: 'api',
          method: 'unknown',
          status: 'failed',
          note: err.message,
        });
        sendJson(res, 502, {
          ok: false,
          error: 'unsubscribe_failed',
          action: 'unsubscribe',
          outcome: 'failed',
          requiresManualAction: false,
          item: mobileEmailItem(getEmailItem(item.id) || item),
          entry,
        });
      }
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/scans') {
    const body = await readJsonObject(req);
    const dryRun = bodyBoolean(body, 'dryRun', true);
    const configuredAccounts = getAccounts().map(account => account.email);
    if (body.account !== undefined && (typeof body.account !== 'string' || !configuredAccounts.includes(body.account))) {
      throw new HttpError(400, 'invalid_account');
    }
    if (body.searchQuery !== undefined && (
      typeof body.searchQuery !== 'string'
      || !body.searchQuery.trim()
      || body.searchQuery.length > 1000
    )) {
      throw new HttpError(400, 'invalid_search_query');
    }
    const accounts = body.account ? [body.account] : configuredAccounts;
    const results = [];
    const scanOpts = { dryRun };
    if (body.searchQuery) scanOpts.searchQuery = body.searchQuery;
    for (const key of ['postToFeed', 'runHooks', 'sendPush']) {
      if (body[key] !== undefined) scanOpts[key] = bodyBoolean(body, key);
    }
    for (const account of accounts) {
      results.push({ account, results: await scan(account, scanOpts) });
    }
    sendJson(res, 200, { ok: true, dryRun, accounts: results });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/events') {
    sendJson(res, 200, {
      events: listEvents({
        since: queryInteger(url, 'since', { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER }),
        limit: queryInteger(url, 'limit', { fallback: 100, min: 1, max: 500 }),
      }),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/events/stream') {
    const since = queryInteger(url, 'since', { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    const send = (event) => res.write(`event: event\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of listEvents({ since, limit: 500 })) send(event);
    storeEvents.on('event', send);
    req.on('close', () => storeEvents.off('event', send));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/summaries/daily') {
    sendJson(res, 200, getDailyActionSummary({
      date: queryDate(url),
      account: url.searchParams.get('account') || '',
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/summaries/lifetime') {
    sendJson(res, 200, getLifetimeActionSummary({
      account: url.searchParams.get('account') || '',
      recentLimit: queryInteger(url, 'recentLimit', { fallback: 25, min: 1, max: 100 }),
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/push/devices') {
    const body = await readJsonObject(req);
    if (typeof body.deviceToken !== 'string' || !body.deviceToken.trim()) {
      sendJson(res, 400, { error: 'deviceToken_required' });
      return;
    }
    if (body.deviceToken.length > 512) throw new HttpError(400, 'invalid_deviceToken');
    if (body.platform !== undefined && body.platform !== 'ios') throw new HttpError(400, 'invalid_platform');
    if (body.appVersion !== undefined && (typeof body.appVersion !== 'string' || body.appVersion.length > 100)) {
      throw new HttpError(400, 'invalid_appVersion');
    }
    sendJson(res, 200, {
      device: registerPushDevice({
        deviceToken: body.deviceToken.trim(),
        platform: body.platform || 'ios',
        appVersion: body.appVersion || '',
      }),
    });
    return;
  }

  const pushDeleteMatch = route(url.pathname, '/v1/push/devices/:id');
  if (req.method === 'DELETE' && pushDeleteMatch) {
    sendJson(res, 200, { ok: deletePushDevice(pushDeleteMatch.id) });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

async function handleMcp(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      endpoint: '/mcp',
      transport: 'streamable-http-json-rpc',
      authentication: 'bearer',
    });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const body = await readJson(req);
  const response = await handleMcpMessage(body);
  if (!response) {
    sendNoContent(res);
    return;
  }
  sendJson(res, 200, response);
}

export function createApiServer() {
  ensureStore();
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        const store = ensureStore();
        sendJson(res, 200, {
          ok: true,
          store: { ok: Boolean(store?.ok) },
          apiTokenConfigured: Boolean(getToken()),
        });
        return;
      }
      if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
        if (!requireAuth(req, res)) return;
        await handleMcp(req, res);
        return;
      }
      if (!url.pathname.startsWith('/v1/')) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (!requireAuth(req, res)) return;
      await handleAuthed(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
        return;
      }
      console.error(`[winnow/api] Unexpected request error: ${err.stack || err.message}`);
      sendJson(res, 500, { error: 'internal_error', message: 'Unexpected server error' });
    }
  });
}

export async function startApiServer(opts = {}) {
  const config = loadConfig();
  const host = opts.host || config.api?.host || '127.0.0.1';
  const port = Number(opts.port ?? config.api?.port ?? 3777);
  const server = createApiServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  console.log(`[winnow/api] Listening on http://${address.address}:${address.port}`);
  return server;
}
