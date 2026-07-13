import { createHash, randomUUID } from 'node:crypto';
import { archiveEmail, markEmailRead, markEmailUnread } from './actions.js';
import { GogAdapter } from './adapters/gog.js';
import { getAccounts } from './config.js';
import { followUnsubscribeLink } from './slack-actions.js';
import { recordUnsubscribe } from './state.js';
import { matchAssistantRule, validateAssistantRule } from './assistant-rules.js';
import {
  createAssistantRule,
  getAssistantRule,
  getEmailItem,
  listRecentTrackedEmailItems,
  setAssistantRuleEnabled,
} from './store.js';

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
  { name: 'mail.get_thread', risk: 'read', description: 'Read one Gmail thread.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'threadId'], properties: { account: { type: 'string' }, threadId: { type: 'string' } } } },
  ...['mail.archive', 'mail.mark_read', 'mail.mark_unread'].map(name => ({ name, risk: 'reversible', description: `${name.split('.')[1].replace('_', ' ')} one Gmail thread.`, inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'threadId'], properties: { account: { type: 'string' }, messageId: { type: 'string' }, threadId: { type: 'string' } } } })),
  { name: 'unsubscribe.request', risk: 'persistent', description: 'Discover and propose an unsubscribe method.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'messageId'], properties: { account: { type: 'string' }, messageId: { type: 'string' }, threadId: { type: 'string' } } } },
  { name: 'mail.send_reply', risk: 'outbound', description: 'Propose sending an exact reply draft.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'messageId', 'draft'], properties: { account: { type: 'string' }, messageId: { type: 'string' }, threadId: { type: 'string' }, draft: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string' }, to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } }, bcc: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' } } } } } },
  { name: 'mail.send_forward', risk: 'outbound', description: 'Propose forwarding a message with exact recipients.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'messageId', 'draft'], properties: { account: { type: 'string' }, messageId: { type: 'string' }, threadId: { type: 'string' }, draft: { type: 'object', additionalProperties: false, required: ['to'], properties: { to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } }, bcc: { type: 'array', items: { type: 'string' } }, note: { type: 'string' }, skipAttachments: { type: 'boolean' } } } } } },
  { name: 'rules.preview', risk: 'read', description: 'Preview deterministic future-mail rule matches.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'effect', 'matcherKind', 'matcherValue'], properties: { account: { type: 'string' }, effect: { enum: ['archive', 'keep'] }, matcherKind: { enum: ['sender', 'domain', 'list_id'] }, matcherValue: { type: 'string' } } } },
  { name: 'rules.create', risk: 'persistent', description: 'Propose creating a deterministic future-mail rule.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'effect', 'matcherKind', 'matcherValue'], properties: { account: { type: 'string' }, effect: { enum: ['archive', 'keep'] }, matcherKind: { enum: ['sender', 'domain', 'list_id'] }, matcherValue: { type: 'string' }, description: { type: 'string' }, sourceEmailItemId: { type: 'string' } } } },
  { name: 'rules.disable', risk: 'persistent', description: 'Propose disabling an assistant-created rule.', inputSchema: { type: 'object', additionalProperties: false, required: ['account', 'ruleId'], properties: { account: { type: 'string' }, ruleId: { type: 'string' } } } },
]);

const DEFINITIONS = new Map(ASSISTANT_TOOL_DEFINITIONS.map(definition => [definition.name, definition]));

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
  if (name === 'rules.preview' || name === 'rules.create') {
    exactKeys(args, ['account', 'effect', 'matcherKind', 'matcherValue', 'description', 'sourceEmailItemId']);
    let rule;
    try {
      rule = validateAssistantRule({
        account: configuredAccount(string(args.account, 'account', { max: 320 })),
        effect: string(args.effect, 'effect', { max: 20 }),
        matcherKind: string(args.matcherKind, 'matcherKind', { max: 30 }),
        matcherValue: string(args.matcherValue, 'matcherValue', { max: 512 }),
      });
    } catch (err) {
      throw new AssistantToolError('invalid_tool_arguments', err.message);
    }
    return {
      account: rule.account,
      effect: rule.effect,
      matcherKind: rule.matcherKind,
      matcherValue: rule.matcherValue,
      ...(args.description === undefined ? {} : { description: string(args.description, 'description', { required: false, max: 1000 }) }),
      ...(args.sourceEmailItemId === undefined ? {} : { sourceEmailItemId: string(args.sourceEmailItemId, 'sourceEmailItemId', { required: false, max: 500 }) }),
    };
  }
  if (name === 'rules.disable') {
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
  if (tool === 'rules.create' && denied(['archive', 'keep', 'create'])) return false;
  if (tool === 'rules.disable' && denied(['disable', 'remove'])) return false;
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
  if (tool === 'rules.create') return /\b(future|always|from now on|rule)\b/.test(request) && /\b(archive|keep)\b/.test(request);
  if (tool === 'rules.disable') return /\b(disable|stop|remove|turn off)\b/.test(request) && /\brule\b/.test(request);
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

function proposalSummary(name, args) {
  if (name === 'unsubscribe.request') return `Unsubscribe from this sender using ${args.method.type === 'http' ? new URL(args.method.url).hostname : 'email'}`;
  if (name === 'mail.send_reply') return `Send this reply${args.draft.to?.length ? ` to ${args.draft.to.join(', ')}` : ''}`;
  if (name === 'mail.send_forward') {
    return `Forward this email to ${args.draft.to.join(', ')} ${args.draft.skipAttachments ? 'without' : 'including'} attachments`;
  }
  if (name === 'rules.create') return `${args.effect === 'archive' ? 'Archive' : 'Keep'} future messages matching ${args.matcherKind} ${args.matcherValue}`;
  if (name === 'rules.disable') return `Disable the ${args.effect} rule for ${args.matcherKind} ${args.matcherValue}`;
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
  if (name === 'rules.preview') {
    const candidates = listRecentTrackedEmailItems({ account: args.account, days: 90, limit: 100 });
    const matches = candidates.filter(message => matchAssistantRule(args, message)).slice(0, 10);
    return {
      kind: 'result', risk: definition.risk,
      result: { rule: args, matchCount: matches.length, sampledAtMost: 100 },
      evidence: matches.map(message => evidenceFromMessage(message, args.account)),
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
  if (name === 'rules.create' && conversation.scope === 'email') {
    args = { ...args, sourceEmailItemId: conversation.emailItemId };
  }
  if (name === 'rules.disable') {
    const rule = getAssistantRule(args.ruleId);
    if (!rule || rule.account !== args.account) throw new AssistantToolError('rule_not_found', 'Assistant rule not found', 404);
    args = { ...args, effect: rule.effect, matcherKind: rule.matcherKind, matcherValue: rule.matcherValue };
  }
  return { kind: 'proposal', risk: definition.risk, arguments: args, summary: proposalSummary(name, args) };
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
  } else if (proposal.tool === 'rules.disable') {
    validationArguments = {
      account: proposal.arguments.account,
      ruleId: proposal.arguments.ruleId,
    };
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
  if (proposal.tool === 'rules.create') {
    const rule = validateAssistantRule(proposal.arguments);
    return createAssistantRule({
      id: randomUUID(),
      ...rule,
      description: proposal.arguments.description || '',
      sourceEmailItemId: proposal.arguments.sourceEmailItemId || '',
    });
  }
  if (proposal.tool === 'rules.disable') {
    const rule = getAssistantRule(proposal.arguments.ruleId);
    if (!rule || rule.account !== proposal.arguments.account) {
      throw new AssistantToolError('rule_not_found', 'Assistant rule not found', 404);
    }
    return setAssistantRuleEnabled(rule.id, false);
  }
  throw new AssistantToolError('proposal_tool_not_executable', 'This tool cannot be confirmed', 400);
}

export function createProposalIdentity() {
  return { id: randomUUID(), nonce: randomUUID(), idempotencyKey: randomUUID() };
}
