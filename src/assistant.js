import { randomUUID } from 'node:crypto';
import { createAssistantModel } from './assistant-model.js';
import {
  ASSISTANT_TOOL_DEFINITIONS,
  AssistantToolError,
  assistantProposalDigest,
  createDefaultAssistantDependencies,
  createProposalIdentity,
  executeAssistantProposal,
  prepareAssistantTool,
} from './assistant-tools.js';
import { getAccounts } from './config.js';
import {
  addAssistantMessage,
  cancelAssistantProposal,
  claimAssistantProposal,
  completeAssistantRun,
  createAssistantConversation as insertAssistantConversation,
  createAssistantProposal,
  createAssistantRun,
  finishAssistantProposal,
  getAssistantConversation,
  getAssistantConversationEnvelope,
  getAssistantProposal,
  getAssistantRunByIdempotencyKey,
  getEmailItem,
  listAssistantMessages,
  recordAssistantToolCall,
} from './store.js';

const PROPOSAL_TTL_MS = 15 * 60 * 1000;
const MAX_TOOL_ROUNDS = 3;

export class AssistantError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let dependenciesFactory = createDefaultAssistantDependencies;

export function setAssistantDependenciesFactoryForTests(factory) {
  dependenciesFactory = factory;
}

export function resetAssistantDependenciesFactoryForTests() {
  dependenciesFactory = createDefaultAssistantDependencies;
}

function configuredAccounts() {
  return getAccounts().map(account => account.email);
}

function requireConfiguredAccount(account) {
  if (!configuredAccounts().includes(account)) {
    throw new AssistantError(400, 'invalid_account', 'Account is not configured in Winnow');
  }
  return account;
}

function normalizeDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
  const kind = draft.kind === 'forward' ? 'forward' : (draft.kind === 'reply' ? 'reply' : '');
  const body = typeof draft.body === 'string' ? draft.body : (typeof draft.note === 'string' ? draft.note : '');
  if (!kind || !body.trim()) return null;
  const normalizeAddresses = value => Array.isArray(value)
    ? value.filter(item => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 320))
    : [];
  return {
    kind,
    to: normalizeAddresses(draft.to),
    cc: normalizeAddresses(draft.cc),
    bcc: normalizeAddresses(draft.bcc),
    subject: String(draft.subject || '').slice(0, 500),
    body: body.slice(0, 20000),
  };
}

function modelMessages(messages) {
  return messages.slice(-30).map(message => ({
    role: message.role,
    text: message.text.slice(0, 4000),
    ...(message.draft ? { draft: message.draft } : {}),
    ...(message.proposal ? {
      proposal: {
        tool: message.proposal.tool,
        status: message.proposal.status,
        summary: message.proposal.summary,
      },
    } : {}),
  }));
}

async function contextualEmail(conversation, dependencies) {
  if (conversation.scope !== 'email') return null;
  const item = getEmailItem(conversation.emailItemId);
  if (!item) throw new AssistantError(404, 'email_not_found', 'The contextual email no longer exists');
  let thread = null;
  try {
    thread = item.threadId ? await dependencies.getThread(item.account, item.threadId) : null;
  } catch {
    // Metadata still gives the assistant a useful, bounded fallback when Gmail is temporarily unavailable.
  }
  return {
    trust: 'untrusted_email_data',
    reference: { account: item.account, messageId: item.messageId, threadId: item.threadId },
    metadata: {
      subject: item.subject,
      from: item.from,
      date: item.processedAt,
      snippet: item.snippet.slice(0, 500),
      summary: item.summary.slice(0, 1000),
    },
    messages: (thread?.messages || []).slice(-20).map(message => ({
      messageId: String(message?.messageId || message?.id || ''),
      threadId: String(message?.threadId || item.threadId || ''),
      from: String(message?.from || '').slice(0, 500),
      to: String(message?.to || '').slice(0, 1000),
      date: String(message?.date || '').slice(0, 100),
      subject: String(message?.subject || '').slice(0, 500),
      body: String(message?.body || '').slice(0, 12000),
    })),
  };
}

export function createConversation({ scope, account = '', emailItemId = '', title = '' }) {
  if (!['email', 'mailbox'].includes(scope)) {
    throw new AssistantError(400, 'invalid_scope', 'scope must be email or mailbox');
  }
  if (account) requireConfiguredAccount(account);
  if (scope === 'email') {
    if (!emailItemId) throw new AssistantError(400, 'email_item_required', 'emailItemId is required for email conversations');
    const item = getEmailItem(emailItemId);
    if (!item) throw new AssistantError(404, 'email_not_found');
    if (account && account !== item.account) throw new AssistantError(400, 'account_scope_mismatch');
    account = item.account;
    title = title || item.subject;
  } else if (emailItemId) {
    throw new AssistantError(400, 'invalid_email_item', 'emailItemId is only valid for email conversations');
  }
  const conversation = insertAssistantConversation({
    id: randomUUID(), scope, account, emailItemId, title,
  });
  return { conversation, messages: [] };
}

export function getConversation(id) {
  const envelope = getAssistantConversationEnvelope(id);
  if (!envelope) throw new AssistantError(404, 'conversation_not_found');
  return envelope;
}

function safeToolAudit(prepared) {
  if (prepared.kind === 'proposal') return null;
  return {
    ok: true,
    evidenceCount: prepared.evidence?.length || 0,
  };
}

function rejectedToolAudit(rawArguments) {
  if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) return {};
  const permitted = ['account', 'messageId', 'threadId', 'ruleId', 'effect', 'matcherKind'];
  const result = {};
  for (const key of permitted) {
    if (typeof rawArguments[key] === 'string') result[key] = rawArguments[key].slice(0, 320);
  }
  return { ...result, suppliedKeys: Object.keys(rawArguments).slice(0, 30) };
}

async function waitForExistingRun(run, timeoutMs = 80_000) {
  const deadline = Date.now() + timeoutMs;
  let current = run;
  while (current?.status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    current = getAssistantRunByIdempotencyKey(current.conversationId, current.idempotencyKey);
  }
  if (current?.status === 'running') {
    throw new AssistantError(409, 'assistant_run_in_progress', 'The original request is still running');
  }
}

function errorText(err) {
  if (err instanceof AssistantToolError) return err.message;
  return 'I couldn’t complete that safely. Please try again.';
}

export async function submitAssistantMessage(conversationId, { text, idempotencyKey = '' }) {
  const conversation = getAssistantConversation(conversationId);
  if (!conversation) throw new AssistantError(404, 'conversation_not_found');
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    throw new AssistantError(400, 'invalid_text', 'text must be between 1 and 4000 characters');
  }
  if (idempotencyKey && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 200)) {
    throw new AssistantError(400, 'invalid_idempotency_key');
  }
  const existingRun = idempotencyKey && getAssistantRunByIdempotencyKey(conversationId, idempotencyKey);
  if (existingRun) {
    await waitForExistingRun(existingRun);
    return getAssistantConversationEnvelope(conversationId);
  }

  const userMessageId = randomUUID();
  const requestedRunId = randomUUID();
  const run = createAssistantRun({
    id: requestedRunId,
    conversationId,
    userMessageId,
    idempotencyKey,
  });
  if (run.id !== requestedRunId) {
    await waitForExistingRun(run);
    return getAssistantConversationEnvelope(conversationId);
  }
  addAssistantMessage({
    id: userMessageId, conversationId, role: 'user', text: text.trim(),
  });

  const toolResults = [];
  const evidence = [];
  try {
    const dependencies = dependenciesFactory();
    const model = createAssistantModel();
    const context = await contextualEmail(conversation, dependencies);
    let response = null;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      response = await model.respond({
        conversation: {
          scope: conversation.scope,
          account: conversation.account,
          contextualReference: context?.reference || null,
        },
        chatMessages: modelMessages(listAssistantMessages(conversationId)),
        contextualEmail: context,
        toolResults,
        availableTools: ASSISTANT_TOOL_DEFINITIONS,
      });
      const calls = Array.isArray(response?.toolCalls) ? response.toolCalls.slice(0, 3) : [];
      if (!calls.length) {
        addAssistantMessage({
          id: randomUUID(), conversationId, role: 'assistant',
          text: response?.text || 'I could not determine a safe answer.',
          evidence, draft: normalizeDraft(response?.draft),
        });
        completeAssistantRun(run.id);
        return getAssistantConversationEnvelope(conversationId);
      }

      let proposed = false;
      // Execute read/reversible work before creating the first proposal. This
      // makes compound requests such as "archive this and future messages"
      // deterministic even if the model returns the proposal call first.
      const orderedCalls = calls.map((call, index) => ({ call, index })).sort((left, right) => {
        const risk = entry => ASSISTANT_TOOL_DEFINITIONS.find(definition => definition.name === entry.call.name)?.risk;
        const priority = entry => ['read', 'reversible'].includes(risk(entry)) ? 0 : 1;
        return priority(left) - priority(right) || left.index - right.index;
      }).map(entry => entry.call);
      for (const call of orderedCalls) {
        const callId = randomUUID();
        try {
          const prepared = await prepareAssistantTool({
            name: call.name,
            rawArguments: call.arguments,
            conversation,
            latestUserText: text,
            dependencies,
          });
          evidence.push(...(prepared.evidence || []));
          if (prepared.kind === 'proposal') {
            const identity = createProposalIdentity();
            const proposalInput = {
              ...identity,
              conversationId,
              tool: call.name,
              arguments: prepared.arguments,
            };
            const confirmationDigest = assistantProposalDigest(proposalInput);
            const proposal = createAssistantProposal({
              id: identity.id,
              conversationId,
              runId: run.id,
              tool: call.name,
              risk: prepared.risk,
              summary: prepared.summary,
              arguments: prepared.arguments,
              confirmationDigest,
              expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
              idempotencyKey: identity.idempotencyKey,
            });
            recordAssistantToolCall({
              id: callId, runId: run.id, proposalId: proposal.id,
              tool: call.name, risk: prepared.risk, arguments: prepared.arguments, status: 'proposed',
            });
            addAssistantMessage({
              id: randomUUID(), conversationId, role: 'assistant',
              text: response?.text || prepared.summary,
              evidence, draft: normalizeDraft(response?.draft), proposalId: proposal.id,
            });
            proposed = true;
            break;
          }
          recordAssistantToolCall({
            id: callId, runId: run.id, tool: call.name, risk: prepared.risk,
            arguments: call.arguments, result: safeToolAudit(prepared), status: 'completed',
          });
          toolResults.push({ tool: call.name, result: prepared.result, trust: 'untrusted_tool_data' });
        } catch (err) {
          recordAssistantToolCall({
            id: callId, runId: run.id, tool: call.name,
            risk: ASSISTANT_TOOL_DEFINITIONS.find(definition => definition.name === call.name)?.risk || 'read',
            arguments: rejectedToolAudit(call.arguments), result: { error: err.code || 'tool_failed' }, status: 'failed',
          });
          throw err;
        }
      }
      if (proposed) {
        completeAssistantRun(run.id);
        return getAssistantConversationEnvelope(conversationId);
      }
    }

    addAssistantMessage({
      id: randomUUID(), conversationId, role: 'assistant', evidence,
      text: 'I reached the safe tool limit before I could finish. Please narrow the request and try again.',
    });
    completeAssistantRun(run.id, { status: 'failed', errorCode: 'tool_limit_reached' });
    return getAssistantConversationEnvelope(conversationId);
  } catch (err) {
    addAssistantMessage({
      id: randomUUID(), conversationId, role: 'assistant', text: errorText(err), evidence,
    });
    completeAssistantRun(run.id, { status: 'failed', errorCode: err.code || 'assistant_failed' });
    return getAssistantConversationEnvelope(conversationId);
  }
}

export async function confirmAssistantProposal(id, confirmationDigest) {
  if (typeof confirmationDigest !== 'string' || !confirmationDigest) {
    throw new AssistantError(400, 'confirmation_digest_required');
  }
  const claimed = claimAssistantProposal(id, confirmationDigest);
  if (!claimed.proposal) throw new AssistantError(404, 'proposal_not_found');
  if (!claimed.claimed) {
    if (['completed', 'cancelled', 'failed'].includes(claimed.reason)) {
      return getAssistantConversationEnvelope(claimed.proposal.conversationId);
    }
    const status = claimed.reason === 'digest_mismatch' ? 403 : 409;
    throw new AssistantError(status, `proposal_${claimed.reason}`);
  }

  const proposal = claimed.proposal;
  const conversation = getAssistantConversation(proposal.conversationId);
  if (!conversation) throw new AssistantError(404, 'conversation_not_found');
  try {
    const result = await executeAssistantProposal(proposal, conversation, dependenciesFactory());
    finishAssistantProposal(id, { status: 'completed', result: { ok: true } });
    addAssistantMessage({
      id: randomUUID(), conversationId: conversation.id, role: 'assistant',
      text: proposal.tool === 'unsubscribe.request'
        ? (result?.status === 'attempted' ? 'The unsubscribe flow needs manual completion.' : 'Unsubscribed successfully.')
        : `${proposal.summary} — done.`,
    });
  } catch (err) {
    finishAssistantProposal(id, { status: 'failed', result: { ok: false, error: err.code || 'execution_failed' } });
    addAssistantMessage({
      id: randomUUID(), conversationId: conversation.id, role: 'assistant',
      text: errorText(err),
    });
  }
  return getAssistantConversationEnvelope(conversation.id);
}

export function cancelProposal(id) {
  const existing = getAssistantProposal(id);
  if (!existing) throw new AssistantError(404, 'proposal_not_found');
  const cancelled = cancelAssistantProposal(id);
  if (cancelled.changed) {
    addAssistantMessage({
      id: randomUUID(), conversationId: existing.conversationId, role: 'assistant',
      text: 'Cancelled. Nothing was changed.',
    });
  }
  return getAssistantConversationEnvelope(existing.conversationId);
}
