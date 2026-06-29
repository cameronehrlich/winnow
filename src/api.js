import http from 'node:http';
import { loadConfig, getAccounts } from './config.js';
import { archiveEmail, markEmailRead, markEmailUnread, moveEmailToInbox } from './actions.js';
import { scan } from './scan.js';
import { recordUnsubscribe } from './state.js';
import { followUnsubscribeLink } from './slack-actions.js';
import {
  deletePushDevice,
  ensureStore,
  getDailyActionSummary,
  getEmailItem,
  listEmailItems,
  listEvents,
  registerPushDevice,
  storeEvents,
} from './store.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024;

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
  });
  res.end(payload);
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

function getToken() {
  return process.env.WINNOW_API_TOKEN || loadConfig().api?.token || '';
}

function requireAuth(req, res) {
  const token = getToken();
  if (!token) {
    sendJson(res, 503, { error: 'api_token_not_configured' });
    return false;
  }
  const header = req.headers.authorization || '';
  if (header !== `Bearer ${token}`) {
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
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
}

async function handleAuthed(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/v1/accounts') {
    sendJson(res, 200, {
      accounts: getAccounts().map(account => ({ email: account.email, channel: account.channel || null })),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/emails') {
    sendJson(res, 200, listEmailItems({
      state: url.searchParams.get('state') || 'all',
      account: url.searchParams.get('account') || '',
      cursor: url.searchParams.get('cursor') || '',
      limit: Number(url.searchParams.get('limit') || 50),
    }));
    return;
  }

  const emailMatch = route(url.pathname, '/v1/emails/:id');
  if (req.method === 'GET' && emailMatch) {
    const item = getEmailItem(emailMatch.id);
    if (!item) sendJson(res, 404, { error: 'email_not_found' });
    else sendJson(res, 200, { item });
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
      const updated = await handler({
        emailItemId: item.id,
        account: item.account,
        threadId: item.threadId,
        messageId: item.messageId,
        source: 'api',
        reason: `API ${suffix}`,
      });
      sendJson(res, 200, { ok: true, item: updated || item });
      return;
    }
  }

  const unsubscribeMatch = route(url.pathname, '/v1/emails/:id/unsubscribe');
  if (req.method === 'POST' && unsubscribeMatch) {
    const item = getEmailItem(unsubscribeMatch.id);
    if (!item) {
      sendJson(res, 404, { error: 'email_not_found' });
    } else if (!item.unsubscribeLink) {
      sendJson(res, 400, { error: 'unsubscribe_link_missing', item });
    } else {
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
        sendJson(res, 200, { ok: true, entry });
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
        sendJson(res, 500, { ok: false, error: 'unsubscribe_failed', entry });
      }
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/scans') {
    const body = await readJson(req);
    const accounts = body.account ? [body.account] : getAccounts().map(a => a.email);
    const results = [];
    for (const account of accounts) {
      results.push({ account, results: await scan(account, { searchQuery: body.searchQuery }) });
    }
    sendJson(res, 200, { ok: true, accounts: results });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/events') {
    sendJson(res, 200, {
      events: listEvents({
        since: Number(url.searchParams.get('since') || 0),
        limit: Number(url.searchParams.get('limit') || 100),
      }),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/events/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event) => res.write(`event: event\ndata: ${JSON.stringify(event)}\n\n`);
    const since = Number(url.searchParams.get('since') || 0);
    for (const event of listEvents({ since, limit: 500 })) send(event);
    storeEvents.on('event', send);
    req.on('close', () => storeEvents.off('event', send));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/summaries/daily') {
    sendJson(res, 200, getDailyActionSummary({
      date: url.searchParams.get('date') || undefined,
      account: url.searchParams.get('account') || '',
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/push/devices') {
    const body = await readJson(req);
    if (!body.deviceToken) {
      sendJson(res, 400, { error: 'deviceToken_required' });
      return;
    }
    sendJson(res, 200, { device: registerPushDevice(body) });
    return;
  }

  const pushDeleteMatch = route(url.pathname, '/v1/push/devices/:id');
  if (req.method === 'DELETE' && pushDeleteMatch) {
    sendJson(res, 200, { ok: deletePushDevice(pushDeleteMatch.id) });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

export function createApiServer() {
  ensureStore();
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, store: ensureStore(), apiTokenConfigured: Boolean(getToken()) });
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
      sendJson(res, 500, { error: 'internal_error', message: err.message });
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
