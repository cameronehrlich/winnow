import { archiveEmail, markEmailRead, markEmailUnread, moveEmailToInbox } from './actions.js';
import { getAccounts } from './config.js';
import { scan } from './scan.js';
import { recordUnsubscribe } from './state.js';
import { followUnsubscribeLink } from './slack-actions.js';
import {
  getDailyActionSummary,
  getEmailItem,
  listEmailItems,
  listEvents,
} from './store.js';
import { getRuntimeStatus, listAccountStatus } from './status.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'winnow', version: '1.0.0' };

function jsonSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

const TOOLS = [
  {
    name: 'winnow_status',
    description: 'Return Winnow runtime status, configured accounts, scan health, and Slack route health without exposing secrets.',
    inputSchema: jsonSchema(),
  },
  {
    name: 'winnow_list_accounts',
    description: 'List configured email accounts and Slack routing metadata without exposing tokens.',
    inputSchema: jsonSchema(),
  },
  {
    name: 'winnow_list_emails',
    description: 'List tracked Winnow email items.',
    inputSchema: jsonSchema({
      state: { type: 'string', enum: ['all', 'inbox', 'archived'], default: 'all' },
      account: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'number', minimum: 1, maximum: 200, default: 50 },
    }),
  },
  {
    name: 'winnow_get_email',
    description: 'Fetch one tracked Winnow email item by id.',
    inputSchema: jsonSchema({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'winnow_daily_summary',
    description: 'Return a daily action summary.',
    inputSchema: jsonSchema({
      date: { type: 'string', description: 'YYYY-MM-DD in America/Los_Angeles' },
      account: { type: 'string' },
    }),
  },
  {
    name: 'winnow_list_events',
    description: 'List recent Winnow event log entries.',
    inputSchema: jsonSchema({
      since: { type: 'number', minimum: 0, default: 0 },
      limit: { type: 'number', minimum: 1, maximum: 500, default: 100 },
    }),
  },
  {
    name: 'winnow_scan',
    description: 'Run a scan. Defaults to dryRun=true so MCP clients do not mutate Gmail or Slack unless explicitly requested.',
    inputSchema: jsonSchema({
      account: { type: 'string', description: 'Optional single account. Omit for all configured accounts.' },
      searchQuery: { type: 'string' },
      dryRun: { type: 'boolean', default: true },
      postToFeed: { type: 'boolean' },
      runHooks: { type: 'boolean' },
      sendPush: { type: 'boolean' },
    }),
  },
  {
    name: 'winnow_archive_email',
    description: 'Archive one tracked email item in Gmail and update Winnow state.',
    inputSchema: jsonSchema({ id: { type: 'string' }, reason: { type: 'string' } }, ['id']),
  },
  {
    name: 'winnow_move_to_inbox',
    description: 'Move one tracked email item back to the Gmail inbox and update Winnow state.',
    inputSchema: jsonSchema({ id: { type: 'string' }, reason: { type: 'string' } }, ['id']),
  },
  {
    name: 'winnow_mark_read',
    description: 'Mark one tracked email item read in Gmail.',
    inputSchema: jsonSchema({ id: { type: 'string' }, reason: { type: 'string' } }, ['id']),
  },
  {
    name: 'winnow_mark_unread',
    description: 'Mark one tracked email item unread in Gmail.',
    inputSchema: jsonSchema({ id: { type: 'string' }, reason: { type: 'string' } }, ['id']),
  },
  {
    name: 'winnow_unsubscribe_email',
    description: 'Follow the stored unsubscribe link for one tracked email item and record the result.',
    inputSchema: jsonSchema({ id: { type: 'string' } }, ['id']),
  },
];

function success(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function failure(id, code, message, data = undefined) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function toolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function requireEmail(id) {
  const item = getEmailItem(id);
  if (!item) {
    const err = new Error('email_not_found');
    err.code = 'email_not_found';
    throw err;
  }
  return item;
}

async function mutateEmail(id, action, reason = '') {
  const item = requireEmail(id);
  const handlers = {
    archive: archiveEmail,
    moveToInbox: moveEmailToInbox,
    markRead: markEmailRead,
    markUnread: markEmailUnread,
  };
  const handler = handlers[action];
  const updated = await handler({
    emailItemId: item.id,
    account: item.account,
    threadId: item.threadId,
    messageId: item.messageId,
    source: 'mcp',
    reason: reason || `MCP ${action}`,
  });
  return { ok: true, action, item: updated || item };
}

async function unsubscribeEmail(id) {
  const item = requireEmail(id);
  if (!item.unsubscribeLink) return { ok: false, error: 'unsubscribe_link_missing', item };

  try {
    const result = await followUnsubscribeLink(item.unsubscribeLink);
    const entry = recordUnsubscribe({
      sender: item.from,
      subject: item.subject,
      account: item.account,
      threadId: item.threadId,
      source: 'mcp',
      method: result.method,
      status: result.status,
      note: result.note,
      urlHost: result.urlHost,
    });
    return { ok: true, entry };
  } catch (err) {
    const entry = recordUnsubscribe({
      sender: item.from,
      subject: item.subject,
      account: item.account,
      threadId: item.threadId,
      source: 'mcp',
      method: 'unknown',
      status: 'failed',
      note: err.message,
    });
    return { ok: false, error: 'unsubscribe_failed', entry };
  }
}

async function runScanTool(args = {}) {
  const dryRun = args.dryRun !== undefined ? Boolean(args.dryRun) : true;
  const accounts = args.account ? [args.account] : getAccounts().map(account => account.email);
  const scanOpts = { dryRun };
  if (args.searchQuery) scanOpts.searchQuery = args.searchQuery;
  for (const key of ['postToFeed', 'runHooks', 'sendPush']) {
    if (args[key] !== undefined) scanOpts[key] = Boolean(args[key]);
  }

  const results = [];
  for (const account of accounts) {
    results.push({ account, results: await scan(account, scanOpts) });
  }
  return { ok: true, dryRun, accounts: results };
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'winnow_status':
      return getRuntimeStatus();
    case 'winnow_list_accounts':
      return { accounts: listAccountStatus() };
    case 'winnow_list_emails':
      return listEmailItems(args);
    case 'winnow_get_email':
      return { item: requireEmail(args.id) };
    case 'winnow_daily_summary':
      return getDailyActionSummary({ date: args.date, account: args.account || '' });
    case 'winnow_list_events':
      return { events: listEvents({ since: args.since || 0, limit: args.limit || 100 }) };
    case 'winnow_scan':
      return runScanTool(args);
    case 'winnow_archive_email':
      return mutateEmail(args.id, 'archive', args.reason);
    case 'winnow_move_to_inbox':
      return mutateEmail(args.id, 'moveToInbox', args.reason);
    case 'winnow_mark_read':
      return mutateEmail(args.id, 'markRead', args.reason);
    case 'winnow_mark_unread':
      return mutateEmail(args.id, 'markUnread', args.reason);
    case 'winnow_unsubscribe_email':
      return unsubscribeEmail(args.id);
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'unknown_tool' });
  }
}

async function handleSingleMessage(message) {
  const id = message?.id;
  if (!message || message.jsonrpc !== '2.0' || !message.method) {
    return failure(id, -32600, 'Invalid JSON-RPC request');
  }

  try {
    if (message.method === 'initialize') {
      return success(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    if (message.method === 'ping') return success(id, {});
    if (message.method === 'notifications/initialized') return null;
    if (message.method === 'tools/list') return success(id, { tools: TOOLS });
    if (message.method === 'tools/call') {
      const { name, arguments: args = {} } = message.params || {};
      if (!name) return failure(id, -32602, 'Missing tool name');
      const result = await callTool(name, args);
      return success(id, toolResult(result));
    }
    return failure(id, -32601, `Method not found: ${message.method}`);
  } catch (err) {
    if (err.code === 'email_not_found') return failure(id, -32004, 'email_not_found');
    if (err.code === 'unknown_tool') return failure(id, -32602, err.message);
    return failure(id, -32000, err.message);
  }
}

export async function handleMcpMessage(message) {
  if (Array.isArray(message)) {
    const responses = (await Promise.all(message.map(handleSingleMessage))).filter(Boolean);
    return responses.length ? responses : null;
  }
  return handleSingleMessage(message);
}
