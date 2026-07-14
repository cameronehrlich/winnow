import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { loadConfig, getAccounts } from './config.js';
import { archiveEmail, markEmailRead, markEmailUnread, moveEmailToInbox } from './actions.js';
import { handlingDecisionKey, handlingUndoAction } from './handling-decisions.js';
import { scan } from './scan.js';
import { findUnsubscribeForEmail, getUnsubscribes, recordUnsubscribe } from './state.js';
import { followUnsubscribeLink } from './slack-actions.js';
import { handleMcpMessage } from './mcp.js';
import { getRuntimeStatus, listAccountStatus } from './status.js';
import { getPushCapabilities } from './push.js';
import { fetchEmailContent } from './email-content.js';
import { SemanticPreviewError } from './semantic-rule-preview.js';
import {
  disableUserRule,
  importUserRules,
  listRulesForApi,
  planUserRuleImport,
  previewUserRule,
  RuleConflictError,
  resetUserRule,
  updateUserRule,
  upsertUserRule,
} from './user-rules.js';
import {
  AssistantError,
  cancelProposal,
  completeAssistantClientProposal,
  confirmAssistantProposal,
  createConversation,
  getConversation,
  submitAssistantMessage,
  validateAssistantMessageRequest,
} from './assistant.js';
import {
  claimHandlingUndo,
  deletePushDevice,
  ensureStore,
  getDailyActionSummary,
  getLifetimeActionSummary,
  getEmailItem,
  listEmailItems,
  listEvents,
  registerPushDevice,
  finishHandlingUndo,
  storeEvents,
} from './store.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const EMAIL_STATES = ['all', 'inbox', 'archived'];
const EMAIL_ACTIONS = ['archive', 'move-to-inbox', 'mark-read', 'mark-unread', 'unsubscribe', 'undo-handling'];

class HttpError extends Error {
  constructor(status, code, message = code, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
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

function createSseWriter(req, res) {
  let connected = true;
  let heartbeat;
  const disconnect = () => {
    connected = false;
    clearInterval(heartbeat);
  };
  req.once('aborted', disconnect);
  res.once('close', disconnect);
  res.once('error', disconnect);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  res.flushHeaders?.();
  heartbeat = setInterval(() => {
    if (!connected || res.destroyed || res.writableEnded) {
      disconnect();
      return;
    }
    try {
      res.write(': heartbeat\n\n');
    } catch {
      disconnect();
    }
  }, 15_000);
  heartbeat.unref?.();
  return {
    send(event, data) {
      if (!connected || res.destroyed || res.writableEnded) return false;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        disconnect();
        return false;
      }
    },
    end() {
      clearInterval(heartbeat);
      if (!connected || res.destroyed || res.writableEnded) return;
      res.end();
    },
  };
}

function assistantStreamError(err) {
  if (err instanceof AssistantError || err instanceof HttpError) {
    return {
      error: err.code,
      message: err.message,
      ...((err.status >= 500 || ['assistant_run_in_progress', 'assistant_run_lease_lost'].includes(err.code))
        ? { retryable: true }
        : {}),
    };
  }
  return {
    error: 'assistant_failed',
    message: 'The assistant request could not be completed safely',
    retryable: true,
  };
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

function assertBodyKeys(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, `invalid_${key}`);
  }
}

function validateAssistantMessageBody(body) {
  assertBodyKeys(body, ['text', 'idempotencyKey']);
  return body;
}

function ruleRequest(callback) {
  try {
    return callback();
  } catch (err) {
    if (err instanceof SemanticPreviewError) {
      throw new HttpError(503, err.code, err.message, { retryable: err.retryable });
    }
    if (err instanceof RuleConflictError) {
      throw new HttpError(409, err.code, err.message);
    }
    if (err instanceof TypeError || err instanceof RangeError) {
      throw new HttpError(400, 'invalid_rule', err.message);
    }
    throw err;
  }
}

async function asyncRuleRequest(callback) {
  try {
    return await callback();
  } catch (err) {
    if (err instanceof SemanticPreviewError) {
      throw new HttpError(503, err.code, err.message, { retryable: err.retryable });
    }
    if (err instanceof RuleConflictError) {
      throw new HttpError(409, err.code, err.message);
    }
    if (err instanceof TypeError || err instanceof RangeError) {
      throw new HttpError(400, 'invalid_rule', err.message);
    }
    throw err;
  }
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
  const {
    handlingUndoDecisionId: _handlingUndoDecisionId,
    handlingUndoStatus: _handlingUndoStatus,
    handlingUndoUpdatedAt: _handlingUndoUpdatedAt,
    ...publicItem
  } = item;
  return {
    ...publicItem,
    undoAction: handlingUndoAction(item),
    unsubscribeState: entry?.status || (item.unsubscribeLink ? 'available' : 'unavailable'),
  };
}

async function handleAuthed(req, res, url, dependencies = {}) {
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
        assistant: {
          conversations: true,
          contextualEmail: true,
          mailboxSearch: true,
          confirmations: true,
        },
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

  if (req.method === 'GET' && url.pathname === '/v1/rules') {
    const account = url.searchParams.get('account') || '';
    sendJson(res, 200, ruleRequest(() => listRulesForApi(account)));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/rules/import') {
    const account = url.searchParams.get('account') || '';
    sendJson(res, 200, ruleRequest(() => planUserRuleImport(account)));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/rules/import') {
    const body = await readJsonObject(req);
    assertBodyKeys(body, ['account', 'dryRun']);
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw new HttpError(400, 'invalid_dryRun');
    sendJson(res, 200, ruleRequest(() => importUserRules(body.account, { dryRun: body.dryRun !== false })));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/rules/preview') {
    const body = await readJsonObject(req);
    assertBodyKeys(body, ['candidate', 'limit']);
    if (!body.candidate || typeof body.candidate !== 'object' || Array.isArray(body.candidate)) {
      throw new HttpError(400, 'invalid_candidate');
    }
    const limit = body.limit === undefined ? 10 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new HttpError(400, 'invalid_limit');
    sendJson(res, 200, await asyncRuleRequest(() => previewUserRule(body.candidate, {
      limit,
      ...(dependencies.semanticRuleEvaluator ? { evaluator: dependencies.semanticRuleEvaluator } : {}),
    })));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/rules') {
    const body = await readJsonObject(req);
    sendJson(res, 201, { rule: ruleRequest(() => upsertUserRule(body, { source: 'api' })) });
    return;
  }

  const userRuleMatch = route(url.pathname, '/v1/rules/:id');
  if (req.method === 'PATCH' && userRuleMatch) {
    const body = await readJsonObject(req);
    const rule = ruleRequest(() => updateUserRule(userRuleMatch.id, body, { source: 'api' }));
    if (!rule) throw new HttpError(404, 'rule_not_found');
    sendJson(res, 200, { rule });
    return;
  }

  const disableRuleMatch = route(url.pathname, '/v1/rules/:id/disable');
  if (req.method === 'POST' && disableRuleMatch) {
    const rule = ruleRequest(() => disableUserRule(disableRuleMatch.id));
    if (!rule) throw new HttpError(404, 'rule_not_found');
    sendJson(res, 200, { rule });
    return;
  }

  const resetRuleMatch = route(url.pathname, '/v1/rules/:id/reset');
  if (req.method === 'POST' && resetRuleMatch) {
    const result = resetUserRule(resetRuleMatch.id);
    if (!result) throw new HttpError(404, 'rule_not_found');
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/assistant/conversations') {
    const body = await readJsonObject(req);
    for (const key of Object.keys(body)) {
      if (!['scope', 'account', 'emailItemId', 'title'].includes(key)) throw new HttpError(400, `invalid_${key}`);
    }
    if (typeof body.scope !== 'string') throw new HttpError(400, 'invalid_scope');
    for (const key of ['account', 'emailItemId', 'title']) {
      if (body[key] !== undefined && typeof body[key] !== 'string') throw new HttpError(400, `invalid_${key}`);
    }
    sendJson(res, 201, createConversation(body));
    return;
  }

  const assistantConversationMatch = route(url.pathname, '/v1/assistant/conversations/:id');
  if (req.method === 'GET' && assistantConversationMatch) {
    sendJson(res, 200, getConversation(assistantConversationMatch.id));
    return;
  }

  const assistantMessageStreamMatch = route(url.pathname, '/v1/assistant/conversations/:id/messages/stream');
  if (req.method === 'POST' && assistantMessageStreamMatch) {
    const body = validateAssistantMessageBody(await readJsonObject(req));
    validateAssistantMessageRequest(assistantMessageStreamMatch.id, body);
    const stream = createSseWriter(req, res);
    try {
      const envelope = await submitAssistantMessage(assistantMessageStreamMatch.id, body, {
        onProgress: event => stream.send(event.type, event.data),
      });
      stream.send('complete', envelope);
    } catch (err) {
      stream.send('error', assistantStreamError(err));
    } finally {
      stream.end();
    }
    return;
  }

  const assistantMessageMatch = route(url.pathname, '/v1/assistant/conversations/:id/messages');
  if (req.method === 'POST' && assistantMessageMatch) {
    const body = validateAssistantMessageBody(await readJsonObject(req));
    sendJson(res, 200, await submitAssistantMessage(assistantMessageMatch.id, body));
    return;
  }

  const assistantConfirmMatch = route(url.pathname, '/v1/assistant/proposals/:id/confirm');
  if (req.method === 'POST' && assistantConfirmMatch) {
    const body = await readJsonObject(req);
    for (const key of Object.keys(body)) {
      if (key !== 'confirmationDigest') throw new HttpError(400, `invalid_${key}`);
    }
    sendJson(res, 200, await confirmAssistantProposal(assistantConfirmMatch.id, body.confirmationDigest));
    return;
  }

  const assistantClientCompleteMatch = route(url.pathname, '/v1/assistant/proposals/:id/complete-client');
  if (req.method === 'POST' && assistantClientCompleteMatch) {
    const body = await readJsonObject(req);
    for (const key of Object.keys(body)) {
      if (key !== 'confirmationDigest') throw new HttpError(400, `invalid_${key}`);
    }
    sendJson(res, 200, completeAssistantClientProposal(
      assistantClientCompleteMatch.id,
      body.confirmationDigest,
    ));
    return;
  }

  const assistantCancelMatch = route(url.pathname, '/v1/assistant/proposals/:id/cancel');
  if (req.method === 'POST' && assistantCancelMatch) {
    sendJson(res, 200, cancelProposal(assistantCancelMatch.id));
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

  const emailContentMatch = route(url.pathname, '/v1/emails/:id/content');
  if (req.method === 'GET' && emailContentMatch) {
    const item = getEmailItem(emailContentMatch.id);
    if (!item) {
      sendJson(res, 404, { error: 'email_not_found' });
      return;
    }
    try {
      const getContent = dependencies.fetchEmailContent || fetchEmailContent;
      sendJson(res, 200, { content: await getContent(item) });
    } catch (err) {
      console.error(`[winnow/api] email content fetch failed for ${item.id}: ${err.message}`);
      sendJson(res, 502, { error: 'email_content_unavailable' });
    }
    return;
  }

  const undoHandlingMatch = route(url.pathname, '/v1/emails/:id/undo-handling');
  if (req.method === 'POST' && undoHandlingMatch) {
    const item = getEmailItem(undoHandlingMatch.id);
    if (!item) {
      sendJson(res, 404, { error: 'email_not_found' });
      return;
    }
    const decisionId = handlingDecisionKey(item);
    const claimToken = randomUUID();
    const claim = claimHandlingUndo(item.id, decisionId, claimToken);
    if (claim.completed) {
      sendJson(res, 200, {
        ok: true,
        action: 'undo-handling',
        item: mobileEmailItem(claim.item || getEmailItem(item.id) || item),
      });
      return;
    }
    if (!claim.claimed) {
      sendJson(res, 409, {
        error: 'handling_not_undoable',
        item: mobileEmailItem(claim.item || getEmailItem(item.id) || item),
      });
      return;
    }
    const undoAction = claim.action;
    const handler = undoAction === 'archive'
      ? (dependencies.archiveEmail || archiveEmail)
      : (dependencies.moveEmailToInbox || moveEmailToInbox);
    try {
      const updated = await handler({
        emailItemId: item.id,
        account: item.account,
        threadId: item.threadId,
        messageId: item.messageId,
        source: 'api',
        reason: 'Undid original Winnow handling; future rule behavior is unchanged',
      });
      finishHandlingUndo(item.id, decisionId, claimToken, { completed: true });
      sendJson(res, 200, {
        ok: true,
        action: 'undo-handling',
        item: mobileEmailItem(getEmailItem(item.id) || updated || item),
      });
    } catch (err) {
      finishHandlingUndo(item.id, decisionId, claimToken, { completed: false });
      console.error(`[winnow/api] undo handling failed for ${item.id}: ${err.message}`);
      sendJson(res, 502, {
        ok: false,
        error: 'email_action_failed',
        action: 'undo-handling',
        item: mobileEmailItem(getEmailItem(item.id) || item),
      });
    }
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
    if (!/^[0-9a-f]+$/i.test(body.deviceToken) || body.deviceToken.length < 32) {
      throw new HttpError(400, 'invalid_deviceToken');
    }
    if (body.platform !== undefined && body.platform !== 'ios') throw new HttpError(400, 'invalid_platform');
    if (body.installationId !== undefined && (
      typeof body.installationId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(body.installationId)
    )) throw new HttpError(400, 'invalid_installationId');
    if (body.environment !== undefined && !['development', 'production'].includes(body.environment)) {
      throw new HttpError(400, 'invalid_environment');
    }
    if (body.bundleId !== undefined && (
      typeof body.bundleId !== 'string' || body.bundleId.length > 200 || !/^[a-zA-Z0-9.-]+$/.test(body.bundleId)
    )) throw new HttpError(400, 'invalid_bundleId');
    if (body.appVersion !== undefined && (typeof body.appVersion !== 'string' || body.appVersion.length > 100)) {
      throw new HttpError(400, 'invalid_appVersion');
    }
    sendJson(res, 200, {
      device: registerPushDevice({
        deviceToken: body.deviceToken.trim(),
        platform: body.platform || 'ios',
        installationId: body.installationId || '',
        environment: body.environment || 'production',
        bundleId: body.bundleId || '',
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

export function createApiServer(dependencies = {}) {
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
      await handleAuthed(req, res, url, dependencies);
    } catch (err) {
      if (err instanceof HttpError || err instanceof AssistantError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...(err.details || {}) });
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
