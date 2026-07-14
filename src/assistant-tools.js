import { createHash, randomUUID } from 'node:crypto';
import { archiveEmail, markEmailRead, markEmailUnread } from './actions.js';
import { GogAdapter } from './adapters/gog.js';
import { getAccounts } from './config.js';
import { followUnsubscribeLink } from './slack-actions.js';
import { recordUnsubscribe } from './state.js';
import { resolveTrackedContacts } from './contact-resolver.js';
import {
  getEmailItem,
  getUserRuleRecord,
} from './store.js';
import {
  disableUserRule,
  getUserRuleConflict,
  listRulesForApi,
  normalizeUserRule,
  previewUserRule,
  resetUserRule,
  upsertUserRule,
} from './user-rules.js';

const MAX_SEARCH_RESULTS = 25;
const MAX_BODY_CHARS = 12000;

export class AssistantToolError extends Error {
  constructor(code, message = code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const ASSISTANT_TOOL_DEFINITIONS = Object.freeze([
  { name: 'mail.search', risk: 'read', description: 'Search configured Gmail accounts.', inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { account: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 25 } } } },
  { name: 'contacts.resolve', risk: 'read', description: 'Resolve a person name to recent correspondent email candidates without guessing.', inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } } } },
  { name: 'mail.get_thread', risk: 'read', description: 'Read one Gmail thread.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'threadId'], properties: { account: { type: 'string' }, threadId: { type: 'string' } } } },
  ...['mail.archive', 'mail.mark_read', 'mail.mark_unread'].map(name => ({ name, risk: 'reversible', description: `${name.split('.')[1].replace('_', ' ')} one Gmail thread.`, inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'threadId'], properties: { account: { type: 'string' }, messageId: { type: 'string' }, threadId: { type: 'string' } } } })),
  { name: 'unsubscribe.request', risk: 'persistent', description: 'Discover and propose an unsubscribe method.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'messageId'], properties: { account: { type: 'string' }, messageId: { type: 'string' }, threadId: { type: 'string' } } } },
  { name: 'mail.send_reply', risk: 'outbound', description: 'Propose sending an exact reply draft.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'messageId', 'draft'], properties: { account: { type: 'string' }, messageId: { type: 'string' }, threadId: { type: 'string' }, draft: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string' }, to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } }, bcc: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' } } } } } },
  { name: 'mail.send_forward', risk: 'outbound', description: 'Propose forwarding a message with exact recipients.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'messageId', 'draft'], properties: { account: { type: 'string' }, messageId: { type: 'string' }, threadId: { type: 'string' }, draft: { type: 'object', additionalProperties: false, required: ['to'], properties: { to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } }, bcc: { type: 'array', items: { type: 'string' } }, note: { type: 'string' }, skipAttachments: { type: 'boolean' } } } } } },
  { name: 'device.create_reminder', risk: 'persistent', description: 'Propose an editable Apple Reminders item. The iOS client performs the save.', inputSchema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, notes: { type: 'string' }, dueAt: { type: 'string' } } } },
  { name: 'device.create_calendar_event', risk: 'persistent', description: 'Propose an editable Apple Calendar event. Exact start and end times are required and the iOS client performs the save.', inputSchema: { type: 'object', additionalProperties: false, required: ['title', 'startAt', 'endAt'], properties: { title: { type: 'string' }, startAt: { type: 'string' }, endAt: { type: 'string' }, isAllDay: { type: 'boolean' }, location: { type: 'string' }, notes: { type: 'string' } } } },
  { name: 'device.pick_contact', risk: 'persistent', description: 'Ask the user to select an exact email address from Apple Contacts when correspondence history is ambiguous or empty.', inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'action'], properties: { name: { type: 'string' }, action: { enum: ['forward'] } } } },
  { name: 'rules.list', risk: 'read', description: 'List editable user rules and effective read-only baseline defaults.', inputSchema: { type: 'object', additionalProperties: false, required: ['account'], properties: { account: { type: 'string' } } } },
  { name: 'rules.preview', risk: 'read', description: 'Validate and preview a structured exact or semantic rule.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'type', 'effect'], properties: { account: { type: 'string' }, type: { enum: ['exact', 'semantic'] }, effect: { enum: ['archive', 'keep'] }, match: { type: 'string' }, matcherKind: { enum: ['sender', 'domain', 'list_id'] }, matcherValue: { type: 'string' }, description: { type: 'string' }, baselineRuleId: { type: 'string' } } } },
  { name: 'rules.upsert', risk: 'persistent', description: 'Propose creating or deterministically replacing a structured user rule.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'type', 'effect'], properties: { id: { type: 'string' }, account: { type: 'string' }, type: { enum: ['exact', 'semantic'] }, effect: { enum: ['archive', 'keep'] }, match: { type: 'string' }, matcherKind: { enum: ['sender', 'domain', 'list_id'] }, matcherValue: { type: 'string' }, description: { type: 'string' }, baselineRuleId: { type: 'string' }, sourceEmailItemId: { type: 'string' } } } },
  { name: 'rules.disable', risk: 'persistent', description: 'Propose disabling an assistant-created rule.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'ruleId'], properties: { account: { type: 'string' }, ruleId: { type: 'string' } } } },
  { name: 'rules.reset', risk: 'persistent', description: 'Propose removing a user rule or resetting a baseline override.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'ruleId'], properties: { account: { type: 'string' }, ruleId: { type: 'string' } } } },
]);

const DEFINITIONS = new Map(ASSISTANT_TOOL_DEFINITIONS.map(definition => [definition.name, definition]));
DEFINITIONS.set('rules.create', DEFINITIONS.get('rules.upsert'));

function object(value, name = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssistantToolError('invalid_tool_arguments', `${name} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed) {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new AssistantToolError('invalid_tool_arguments', `Unexpected argument: ${extra[0]}`);
}

function string(value, name, { required = true, max = 1000 } = {}) {
  if ((!required && (value === undefined || value === null || value === ''))) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AssistantToolError('invalid_tool_arguments', `${name} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

function addresses(value, name, { required = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > 20) {
    throw new AssistantToolError('invalid_tool_arguments', `${name} must be an array of email addresses`);
  }
  return value.map((address, index) => {
    const normalized = string(address, `${name}[${index}]`, { max: 320 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new AssistantToolError('invalid_tool_arguments', `${name}[${index}] is not a valid email address`);
    }
    return normalized;
  });
}

function normalizeDraft(value, kind) {
  const draft = object(value, 'draft');
  exactKeys(draft, kind === 'reply'
    ? ['body', 'to', 'cc', 'bcc', 'subject']
    : ['to', 'cc', 'bcc', 'note', 'skipAttachments']);
  if (kind === 'reply') {
    return {
      body: string(draft.body, 'draft.body', { max: 20000 }),
      ...(draft.to === undefined ? {} : { to: addresses(draft.to, 'draft.to') }),
      ...(draft.cc === undefined ? {} : { cc: addresses(draft.cc, 'draft.cc') }),
      ...(draft.bcc === undefined ? {} : { bcc: addresses(draft.bcc, 'draft.bcc') }),
      ...(draft.subject === undefined ? {} : { subject: string(draft.subject, 'draft.subject', { required: false, max: 500 }) }),
    };
  }
  if (draft.skipAttachments !== undefined && typeof draft.skipAttachments !== 'boolean') {
    throw new AssistantToolError('invalid_tool_arguments', 'draft.skipAttachments must be a boolean');
  }
  return {
    to: addresses(draft.to, 'draft.to', { required: true }),
    ...(draft.cc === undefined ? {} : { cc: addresses(draft.cc, 'draft.cc') }),
    ...(draft.bcc === undefined ? {} : { bcc: addresses(draft.bcc, 'draft.bcc') }),
    ...(draft.note === undefined ? {} : { note: string(draft.note, 'draft.note', { required: false, max: 20000 }) }),
    skipAttachments: draft.skipAttachments === true,
  };
}

function optionalString(value, name, max) {
  if (value === undefined || value === null || value === '') return '';
  return string(value, name, { max });
}

function isoDate(value, name, { required = true } = {}) {
  const result = string(value, name, { required, max: 100 });
  if (!result) return '';
  if (!Number.isFinite(Date.parse(result))) {
    throw new AssistantToolError('invalid_tool_arguments', `${name} must be an ISO 8601 date`);
  }
  return result;
}

function configuredAccount(account) {
  const allowed = getAccounts().map(item => item.email);
  if (!allowed.includes(account)) {
    throw new AssistantToolError('invalid_account', 'The account is not configured in Winnow');
  }
  return account;
}

function normalizeRef(args, allowedKeys) {
  exactKeys(args, allowedKeys);
  return {
    account: configuredAccount(string(args.account, 'account', { max: 320 })),
    messageId: string(args.messageId, 'messageId', { required: false, max: 300 }),
    threadId: string(args.threadId, 'threadId', { required: false, max: 300 }),
  };
}

export function validateAssistantToolCall(name, rawArguments) {
  if (!DEFINITIONS.has(name)) throw new AssistantToolError('unknown_tool', `Unknown assistant tool: ${name}`);
  const args = object(rawArguments);
  if (name === 'mail.search') {
    exactKeys(args, ['account', 'query', 'limit']);
    const limit = args.limit === undefined ? 10 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
      throw new AssistantToolError('invalid_tool_arguments', `limit must be between 1 and ${MAX_SEARCH_RESULTS}`);
    }
    return {
      account: args.account ? configuredAccount(string(args.account, 'account', { max: 320 })) : '',
      query: string(args.query, 'query', { max: 1000 }),
      limit,
    };
  }
  if (name === 'contacts.resolve') {
    exactKeys(args, ['query', 'limit']);
    const limit = args.limit === undefined ? 5 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new AssistantToolError('invalid_tool_arguments', 'limit must be between 1 and 10');
    }
    return { query: string(args.query, 'query', { max: 200 }), limit };
  }
  if (name === 'mail.get_thread') {
    const ref = normalizeRef(args, ['account', 'threadId']);
    if (!ref.threadId) throw new AssistantToolError('invalid_tool_arguments', 'threadId is required');
    return { account: ref.account, threadId: ref.threadId };
  }
  if (['mail.archive', 'mail.mark_read', 'mail.mark_unread'].includes(name)) {
    const ref = normalizeRef(args, ['account', 'messageId', 'threadId']);
    if (!ref.threadId) throw new AssistantToolError('invalid_tool_arguments', 'threadId is required');
    return ref;
  }
  if (name === 'unsubscribe.request') {
    const ref = normalizeRef(args, ['account', 'messageId', 'threadId']);
    if (!ref.messageId) throw new AssistantToolError('invalid_tool_arguments', 'messageId is required');
    return ref;
  }
  if (name === 'mail.send_reply' || name === 'mail.send_forward') {
    const ref = normalizeRef(args, ['account', 'messageId', 'threadId', 'draft']);
    if (!ref.messageId) throw new AssistantToolError('invalid_tool_arguments', 'messageId is required');
    return {
      ...ref,
      draft: normalizeDraft(args.draft, name === 'mail.send_reply' ? 'reply' : 'forward'),
    };
  }
  if (name === 'device.create_reminder') {
    exactKeys(args, ['title', 'notes', 'dueAt']);
    return {
      title: string(args.title, 'title', { max: 500 }),
      notes: optionalString(args.notes, 'notes', 4000),
      dueAt: isoDate(args.dueAt, 'dueAt', { required: false }),
    };
  }
  if (name === 'device.create_calendar_event') {
    exactKeys(args, ['title', 'startAt', 'endAt', 'isAllDay', 'location', 'notes']);
    const startAt = isoDate(args.startAt, 'startAt');
    const endAt = isoDate(args.endAt, 'endAt');
    if (Date.parse(endAt) <= Date.parse(startAt)) {
      throw new AssistantToolError('invalid_tool_arguments', 'endAt must be after startAt');
    }
    if (args.isAllDay !== undefined && typeof args.isAllDay !== 'boolean') {
      throw new AssistantToolError('invalid_tool_arguments', 'isAllDay must be a boolean');
    }
    return {
      title: string(args.title, 'title', { max: 500 }),
      startAt,
      endAt,
      isAllDay: args.isAllDay === true,
      location: optionalString(args.location, 'location', 1000),
      notes: optionalString(args.notes, 'notes', 4000),
    };
  }
  if (name === 'device.pick_contact') {
    exactKeys(args, ['name', 'action']);
    if (args.action !== 'forward') {
      throw new AssistantToolError('invalid_tool_arguments', 'device.pick_contact only supports forward');
    }
    return { name: string(args.name, 'name', { max: 200 }), action: 'forward' };
  }
  if (name === 'rules.list') {
    exactKeys(args, ['account']);
    return { account: configuredAccount(string(args.account, 'account', { max: 320 })) };
  }
  if (name === 'rules.preview' || name === 'rules.upsert' || name === 'rules.create') {
    const allowed = [
      'id', 'account', 'type', 'effect', 'match', 'matcherKind', 'matcherValue',
      'description', 'baselineRuleId', 'sourceEmailItemId',
    ];
    exactKeys(args, name === 'rules.preview' ? allowed.filter(key => !['id', 'sourceEmailItemId'].includes(key)) : allowed);
    let rule;
    try {
      rule = normalizeUserRule({
        ...args,
        account: configuredAccount(string(args.account, 'account', { max: 320 })),
        type: args.type || 'exact',
      }, { source: 'assistant' });
    } catch (err) {
      throw new AssistantToolError('invalid_tool_arguments', err.message);
    }
    return {
      ...(args.id ? { id: args.id } : {}),
      account: rule.account,
      type: rule.type,
      effect: rule.effect,
      ...(rule.type === 'exact'
        ? { matcherKind: rule.matcherKind, matcherValue: rule.matcherValue }
        : { match: rule.match }),
      ...(rule.description ? { description: rule.description } : {}),
      ...(rule.baselineRuleId ? { baselineRuleId: rule.baselineRuleId } : {}),
      ...(rule.sourceEmailItemId ? { sourceEmailItemId: rule.sourceEmailItemId } : {}),
    };
  }
  if (name === 'rules.disable' || name === 'rules.reset') {
    exactKeys(args, ['account', 'ruleId']);
    return {
      account: configuredAccount(string(args.account, 'account', { max: 320 })),
      ruleId: string(args.ruleId, 'ruleId', { max: 300 }),
    };
  }
  throw new AssistantToolError('unknown_tool');
}

function enforceConversationScope(conversation, args) {
  if (conversation.account && args.account && conversation.account !== args.account) {
    throw new AssistantToolError('account_scope_mismatch', 'Tool account does not match the conversation account', 403);
  }
  if (conversation.scope !== 'email') return args;
  const item = getEmailItem(conversation.emailItemId);
  if (!item) throw new AssistantToolError('email_not_found', 'The contextual email no longer exists', 404);
  if (args.account && args.account !== item.account) throw new AssistantToolError('email_scope_mismatch', 'Tool does not target the contextual email', 403);
  if (args.messageId && args.messageId !== item.messageId) throw new AssistantToolError('email_scope_mismatch', 'Tool does not target the contextual email', 403);
  if (args.threadId && args.threadId !== item.threadId) throw new AssistantToolError('email_scope_mismatch', 'Tool does not target the contextual email', 403);
  return {
    ...args,
    account: item.account,
    ...(Object.hasOwn(args, 'messageId') ? { messageId: item.messageId } : {}),
    ...(Object.hasOwn(args, 'threadId') ? { threadId: item.threadId } : {}),
  };
}

function actionExplicitlyRequested(tool, text) {
  const request = String(text || '').toLowerCase();
  if (/\bshould i\b|\bdo you think\b|\bwhat (?:if|about)\b/.test(request)) return false;
  const denied = terms => {
    const action = `(?:${terms.join('|')})`;
    return new RegExp(`\\b(?:don't|do not|never|not|without)\\b.{0,30}\\b${action}\\b`).test(request)
      || new RegExp(`\\b(?:why|when)\\b.{0,40}\\b${action}(?:d|ed)?\\b`).test(request)
      || new RegExp(`\\bdid\\s+(?:you|winnow|i)\\b.{0,24}\\b${action}\\b`).test(request);
  };
  if (tool === 'mail.archive' && denied(['archive'])) return false;
  if (tool === 'mail.mark_read' && denied(['mark', 'read'])) return false;
  if (tool === 'mail.mark_unread' && denied(['mark', 'unread'])) return false;
  if (tool === 'unsubscribe.request' && denied(['unsubscribe', 'opt[ -]?out'])) return false;
  if (tool === 'mail.send_reply' && denied(['reply', 'respond', 'send'])) return false;
  if (tool === 'mail.send_forward' && denied(['forward', 'send'])) return false;
  if (tool === 'device.create_reminder' && denied(['remind', 'reminder'])) return false;
  if (tool === 'device.create_calendar_event' && denied(['calendar', 'schedule', 'event'])) return false;
  if (tool === 'device.pick_contact' && denied(['forward', 'send'])) return false;
  if (['rules.create', 'rules.upsert'].includes(tool) && denied(['archive', 'keep', 'create', 'update'])) return false;
  if (tool === 'rules.disable' && denied(['disable', 'remove'])) return false;
  if (tool === 'rules.reset' && denied(['reset', 'remove', 'restore'])) return false;
  if (tool === 'mail.archive') return /\barchive\b/.test(request);
  if (tool === 'mail.mark_read') return /\bmark\b.{0,12}\bread\b/.test(request);
  if (tool === 'mail.mark_unread') return /\bmark\b.{0,12}\bunread\b/.test(request);
  if (tool === 'unsubscribe.request') return /\bunsubscribe\b|\bopt[ -]?out\b/.test(request);
  if (tool === 'mail.send_reply') {
    return /\b(reply|respond|send)\b/.test(request) && !(/\bdraft\b/.test(request) && !/\bsend\b/.test(request));
  }
  if (tool === 'mail.send_forward') {
    return /\bforward\b/.test(request) && !(/\bdraft\b/.test(request) && !/\bsend\b/.test(request));
  }
  if (tool === 'device.create_reminder') return /\b(remind|reminder)\b/.test(request);
  if (tool === 'device.create_calendar_event') {
    return /\b(calendar|schedule|event)\b/.test(request) && /\b(add|create|put|schedule)\b/.test(request);
  }
  if (tool === 'device.pick_contact') return /\bforward\b/.test(request);
  if (['rules.create', 'rules.upsert'].includes(tool)) return /\b(future|always|from now on|rule)\b/.test(request) && /\b(archive|keep|update|change|override)\b/.test(request);
  if (tool === 'rules.disable') return /\b(disable|stop|remove|turn off)\b/.test(request) && /\brule\b/.test(request);
  if (tool === 'rules.reset') return /\b(reset|restore|remove)\b/.test(request) && /\brule\b/.test(request);
  return true;
}

function messageHeaders(message) {
  const candidates = [
    message?.headers,
    message?.payload?.headers,
    message?.message?.headers,
    message?.message?.payload?.headers,
  ];
  for (const headers of candidates) {
    if (Array.isArray(headers)) {
      return Object.fromEntries(headers
        .filter(header => typeof header?.name === 'string')
        .map(header => [header.name.toLowerCase(), String(header.value || '')]));
    }
    if (headers && typeof headers === 'object') {
      return Object.fromEntries(Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), String(value || '')]));
    }
  }
  return {};
}

function emailAddress(value) {
  const input = String(value || '').trim();
  const candidate = (input.match(/<([^<>]+@[^<>]+)>/)?.[1] || input).trim();
  return /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(candidate) ? candidate : '';
}

function evidenceFromMessage(message, account) {
  return {
    account,
    messageId: String(message?.messageId || message?.id || ''),
    threadId: String(message?.threadId || ''),
    subject: String(message?.subject || '').slice(0, 500),
    from: String(message?.from || '').slice(0, 500),
    date: String(message?.date || '').slice(0, 100),
    snippet: String(message?.snippet || '').slice(0, 500),
  };
}

function boundedMessageForModel(message) {
  return {
    ...evidenceFromMessage(message, message?.account || ''),
    to: String(message?.to || '').slice(0, 1000),
    cc: String(message?.cc || '').slice(0, 1000),
    body: String(message?.body || '').slice(0, MAX_BODY_CHARS),
  };
}

function proposalSummary(name, args, { replacementRule = null } = {}) {
  if (name === 'unsubscribe.request') return `Unsubscribe from this sender using ${args.method.type === 'http' ? new URL(args.method.url).hostname : 'email'}`;
  if (name === 'mail.send_reply') return `Send this reply${args.draft.to?.length ? ` to ${args.draft.to.join(', ')}` : ''}`;
  if (name === 'mail.send_forward') {
    return `Forward this email to ${args.draft.to.join(', ')} ${args.draft.skipAttachments ? 'without' : 'including'} attachments`;
  }
  if (name === 'device.create_reminder') return `Create the reminder “${args.title}”`;
  if (name === 'device.create_calendar_event') return `Add “${args.title}” to Calendar`;
  if (name === 'device.pick_contact') return `Choose the email address for ${args.name}`;
  if (name === 'rules.create' || name === 'rules.upsert') {
    const base = args.type === 'exact'
      ? `${args.effect === 'archive' ? 'Archive' : 'Keep'} future messages matching ${args.matcherKind} ${args.matcherValue}`
      : `${args.effect === 'archive' ? 'Archive' : 'Keep'} messages matching the semantic rule: ${args.match}`;
    const replacementName = replacementRule?.description
      || replacementRule?.matcherValue
      || replacementRule?.match
      || replacementRule?.id;
    return replacementName ? `${base}, replacing the existing rule “${replacementName}”` : base;
  }
  if (name === 'rules.disable') return `Disable the ${args.effect} rule for ${args.matcherKind} ${args.matcherValue}`;
  if (name === 'rules.reset') return args.baselineRuleId
    ? `Reset the override for baseline rule ${args.baselineRuleId}`
    : `Remove the user rule ${args.ruleId}`;
  return `Confirm ${name}`;
}

export function createDefaultAssistantDependencies() {
  const adapter = new GogAdapter();
  return {
    async searchMailbox(account, query, limit) { return adapter.searchMailbox(account, query, limit); },
    async getThread(account, threadId) { return adapter.getThread(account, threadId); },
    async getMessage(account, messageId) { return adapter.getMessage(account, messageId); },
    async archive(args) { return archiveEmail({ ...args, source: 'assistant', reason: 'Assistant archive' }); },
    async markRead(args) { return markEmailRead({ ...args, source: 'assistant', reason: 'Assistant mark read' }); },
    async markUnread(args) { return markEmailUnread({ ...args, source: 'assistant', reason: 'Assistant mark unread' }); },
    async discoverUnsubscribe(message) {
      const { discoverUnsubscribeMethods } = await import('./unsubscribe-discovery.js');
      return discoverUnsubscribeMethods(message);
    },
    async executeUnsubscribe(method, args) {
      const result = await followUnsubscribeLink(method.url);
      recordUnsubscribe({
        sender: args.sender || '', subject: args.subject || '', account: args.account,
        threadId: args.threadId || '', source: 'assistant', method: result.method,
        status: result.status, note: result.note, urlHost: result.urlHost,
      });
      return result;
    },
    async reply(account, ref, draft) {
      if (ref.threadId) await adapter.getThread(account, ref.threadId);
      return adapter.reply(account, ref, draft);
    },
    async forward(account, ref, draft) {
      if (ref.threadId) await adapter.getThread(account, ref.threadId);
      return adapter.forward(account, ref, draft);
    },
  };
}

export async function prepareAssistantTool({ name, rawArguments, conversation, latestUserText, dependencies }) {
  const definition = DEFINITIONS.get(name);
  let args = enforceConversationScope(conversation, validateAssistantToolCall(name, rawArguments));
  let replacementRule = null;
  if (!actionExplicitlyRequested(name, latestUserText)) {
    throw new AssistantToolError('action_not_requested', 'Email content cannot authorize an action; ask the user explicitly', 403);
  }

  if (name === 'mail.search') {
    const accounts = args.account ? [args.account] : getAccounts().map(item => item.email);
    if (conversation.account && !args.account) accounts.splice(0, accounts.length, conversation.account);
    const perAccountLimit = Math.max(1, Math.ceil(args.limit / accounts.length));
    const batches = await Promise.all(accounts.map(async account => ({
      account,
      result: await dependencies.searchMailbox(account, args.query, perAccountLimit),
    })));
    const messages = batches.flatMap(({ account, result }) =>
      (result?.messages || []).map(message => ({ account, message }))
    ).slice(0, args.limit);
    return {
      kind: 'result', risk: definition.risk,
      result: { messages: messages.map(({ account, message }) => evidenceFromMessage(message, account)) },
      evidence: messages.map(({ account, message }) => evidenceFromMessage(message, account)),
    };
  }
  if (name === 'contacts.resolve') {
    return {
      kind: 'result', risk: definition.risk,
      result: { query: args.query, candidates: resolveTrackedContacts(args.query, { limit: args.limit }) },
      evidence: [],
    };
  }
  if (name === 'mail.get_thread') {
    const thread = await dependencies.getThread(args.account, args.threadId);
    const messages = (thread?.messages || []).slice(-20);
    return {
      kind: 'result', risk: definition.risk,
      result: { id: thread?.id || args.threadId, messages: messages.map(boundedMessageForModel) },
      evidence: messages.map(message => evidenceFromMessage(message, args.account)),
    };
  }
  if (name === 'mail.archive') {
    return { kind: 'result', risk: definition.risk, result: await dependencies.archive(args), evidence: [] };
  }
  if (name === 'mail.mark_read') {
    return { kind: 'result', risk: definition.risk, result: await dependencies.markRead(args), evidence: [] };
  }
  if (name === 'mail.mark_unread') {
    return { kind: 'result', risk: definition.risk, result: await dependencies.markUnread(args), evidence: [] };
  }
  if (name.startsWith('device.')) {
    if (conversation.scope !== 'email') {
      throw new AssistantToolError('email_scope_required', 'Open an email before creating this device action', 400);
    }
    const item = getEmailItem(conversation.emailItemId);
    if (!item) throw new AssistantToolError('email_not_found', 'The contextual email no longer exists', 404);
    args = {
      ...args,
      source: {
        emailItemId: item.id,
        account: item.account,
        mailboxState: item.mailboxState,
        subject: item.subject,
      },
    };
  }
  if (name === 'rules.list') {
    return {
      kind: 'result', risk: definition.risk,
      result: listRulesForApi(args.account),
      evidence: [],
    };
  }
  if (name === 'rules.preview') {
    const preview = await previewUserRule(args, {
      ...(dependencies.semanticRuleEvaluator ? { evaluator: dependencies.semanticRuleEvaluator } : {}),
    });
    return {
      kind: 'result', risk: definition.risk,
      result: preview,
      evidence: preview.matches || preview.evidence || [],
    };
  }
  if (name === 'unsubscribe.request') {
    const message = await dependencies.getMessage(args.account, args.messageId);
    const discovered = await dependencies.discoverUnsubscribe(message);
    const method = discovered?.preferred;
    if (!method?.url || !['http', 'mailto'].includes(method.type)) {
      throw new AssistantToolError('unsubscribe_unavailable', 'No defensible unsubscribe method was found', 422);
    }
    args = { ...args, method, sender: message?.from || '', subject: message?.subject || '' };
  }
  if (name === 'mail.send_reply' && !args.draft.to?.length) {
    const message = await dependencies.getMessage(args.account, args.messageId);
    const headers = messageHeaders(message);
    const recipient = emailAddress(headers['reply-to'] || headers.from || message?.from);
    if (!recipient) {
      throw new AssistantToolError('reply_recipient_unavailable', 'The exact reply recipient could not be determined', 422);
    }
    args = { ...args, draft: { ...args.draft, to: [recipient] } };
  }
  if ((name === 'rules.create' || name === 'rules.upsert') && conversation.scope === 'email') {
    args = { ...args, sourceEmailItemId: conversation.emailItemId };
  }
  if (name === 'rules.create' || name === 'rules.upsert') {
    const editedRule = args.id ? getUserRuleRecord(args.id) : null;
    replacementRule = getUserRuleConflict(args, { source: 'assistant' });
    if (editedRule) {
      args = {
        ...args,
        expectedRule: {
          ruleId: editedRule.id,
          updatedAt: editedRule.updatedAt,
        },
      };
    }
    if (replacementRule) {
      args = {
        ...args,
        expectedConflict: {
          ruleId: replacementRule.id,
          updatedAt: replacementRule.updatedAt,
        },
      };
    }
  }
  if (name === 'rules.disable' || name === 'rules.reset') {
    const rule = getUserRuleRecord(args.ruleId);
    if (!rule || rule.account !== args.account) throw new AssistantToolError('rule_not_found', 'Assistant rule not found', 404);
    if (name === 'rules.disable' && rule.baselineRuleId) {
      throw new AssistantToolError(
        'baseline_override_requires_reset',
        'A baseline customization must be reset instead of disabled',
        400,
      );
    }
    args = {
      ...args,
      type: rule.type,
      effect: rule.effect,
      matcherKind: rule.matcherKind,
      matcherValue: rule.matcherValue,
      match: rule.match,
      baselineRuleId: rule.baselineRuleId,
    };
  }
  return {
    kind: 'proposal', risk: definition.risk, arguments: args,
    summary: proposalSummary(name, args, { replacementRule }),
  };
}

export function assistantProposalDigest(proposal) {
  return createHash('sha256').update(JSON.stringify({
    id: proposal.id,
    conversationId: proposal.conversationId,
    tool: proposal.tool,
    arguments: proposal.arguments,
    nonce: proposal.nonce,
  })).digest('base64url');
}

export async function executeAssistantProposal(proposal, conversation, dependencies) {
  let validationArguments = proposal.arguments;
  if (proposal.tool === 'unsubscribe.request') {
    validationArguments = {
      account: proposal.arguments.account,
      messageId: proposal.arguments.messageId,
      threadId: proposal.arguments.threadId,
    };
  } else if (proposal.tool === 'rules.disable' || proposal.tool === 'rules.reset') {
    validationArguments = {
      account: proposal.arguments.account,
      ruleId: proposal.arguments.ruleId,
    };
  } else if (proposal.tool === 'rules.create' || proposal.tool === 'rules.upsert') {
    const {
      expectedConflict: _expectedConflict,
      expectedRule: _expectedRule,
      ...ruleArguments
    } = proposal.arguments;
    validationArguments = ruleArguments;
  }
  const args = enforceConversationScope(conversation, validateAssistantToolCall(
    proposal.tool,
    validationArguments
  ));
  if (proposal.tool === 'unsubscribe.request') {
    const message = await dependencies.getMessage(args.account, args.messageId);
    const discovered = await dependencies.discoverUnsubscribe(message);
    const current = discovered?.methods?.find(method => (
      method.type === proposal.arguments.method?.type && method.url === proposal.arguments.method?.url
    ));
    if (!current) throw new AssistantToolError('unsubscribe_method_changed', 'The unsubscribe method changed; request a new proposal', 409);
    return dependencies.executeUnsubscribe(current, proposal.arguments);
  }
  if (proposal.tool === 'mail.send_reply') {
    return dependencies.reply(args.account, { messageId: args.messageId, threadId: args.threadId }, args.draft);
  }
  if (proposal.tool === 'mail.send_forward') {
    return dependencies.forward(args.account, { messageId: args.messageId, threadId: args.threadId }, args.draft);
  }
  if (proposal.tool === 'rules.create' || proposal.tool === 'rules.upsert') {
    return upsertUserRule(proposal.arguments, { source: 'assistant' });
  }
  if (proposal.tool === 'rules.disable') {
    const rule = getUserRuleRecord(proposal.arguments.ruleId);
    if (!rule || rule.account !== proposal.arguments.account) {
      throw new AssistantToolError('rule_not_found', 'Assistant rule not found', 404);
    }
    return disableUserRule(rule.id);
  }
  if (proposal.tool === 'rules.reset') {
    const rule = getUserRuleRecord(proposal.arguments.ruleId);
    if (!rule || rule.account !== proposal.arguments.account) {
      throw new AssistantToolError('rule_not_found', 'Assistant rule not found', 404);
    }
    return resetUserRule(rule.id);
  }
  throw new AssistantToolError('proposal_tool_not_executable', 'This tool cannot be confirmed', 400);
}

export function createProposalIdentity() {
  return { id: randomUUID(), nonce: randomUUID(), idempotencyKey: randomUUID() };
}
