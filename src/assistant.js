import { createHash, randomUUID } from 'node:crypto';
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
  assistantRunHasTerminalOutput,
  cancelAssistantProposal,
  claimStaleAssistantRun,
  claimAssistantProposal,
  completeAssistantRun,
  createAssistantConversation as insertAssistantConversation,
  createAssistantRunWithUserMessage,
  finishAssistantProposal,
  finishAssistantRunWithMessage,
  finishAssistantRunWithProposal,
  getAssistantConversation,
  getAssistantConversationEnvelope,
  getAssistantMessage,
  getOrCreateAssistantEmailConversation,
  getAssistantProposal,
  getAssistantRunByIdempotencyKey,
  getEmailItem,
  listAssistantMessages,
  recordAssistantToolCall,
  touchAssistantRunLease,
} from './store.js';

const PROPOSAL_TTL_MS = 15 * 60 * 1000;
const MAX_TOOL_ROUNDS = 3;
const ASSISTANT_RUN_LEASE_MS = 2 * 60 * 1000;
const ASSISTANT_RUN_HEARTBEAT_MS = 30 * 1000;
const DEFAULT_ASSISTANT_MODEL_TIMEOUT_MS = 75 * 1000;
const CLIENT_ASSISTANT_TOOLS = new Set([
  'device.create_reminder',
  'device.create_calendar_event',
  'device.pick_contact',
]);
let assistantModelTimeoutMs = DEFAULT_ASSISTANT_MODEL_TIMEOUT_MS;

export const ASSISTANT_PROGRESS_STAGES = Object.freeze({
  replay: 'replay',
  resume: 'resume',
  waiting: 'waiting',
  context: 'context',
  model: 'model',
  modelComplete: 'model_complete',
  tool: 'tool',
  toolComplete: 'tool_complete',
  confirmation: 'confirmation',
  finalizing: 'finalizing',
});

export const ASSISTANT_PROGRESS_LABELS = Object.freeze({
  [ASSISTANT_PROGRESS_STAGES.replay]: 'Returning the completed request',
  [ASSISTANT_PROGRESS_STAGES.resume]: 'Resuming an interrupted request',
  [ASSISTANT_PROGRESS_STAGES.waiting]: 'Waiting for the existing request',
  [ASSISTANT_PROGRESS_STAGES.context]: 'Reading the relevant context',
  [ASSISTANT_PROGRESS_STAGES.model]: 'Thinking it through',
  [ASSISTANT_PROGRESS_STAGES.modelComplete]: 'The answer is taking shape',
  [ASSISTANT_PROGRESS_STAGES.tool]: 'Checking your mailbox',
  [ASSISTANT_PROGRESS_STAGES.toolComplete]: 'Mailbox check complete',
  [ASSISTANT_PROGRESS_STAGES.confirmation]: 'Getting your confirmation ready',
  [ASSISTANT_PROGRESS_STAGES.finalizing]: 'Finishing up',
});

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

export function setAssistantModelTimeoutForTests(timeoutMs) {
  assistantModelTimeoutMs = timeoutMs;
}

export function resetAssistantModelTimeoutForTests() {
  assistantModelTimeoutMs = DEFAULT_ASSISTANT_MODEL_TIMEOUT_MS;
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

function explicitlyRequestsMailboxSearch(text) {
  const request = String(text || '').toLowerCase();
  return /\b(?:search|find|locate|look up|show|list)\b.{0,60}\b(?:email|emails|mail|message|messages|invoice|invoices|receipt|receipts|order|orders)\b/.test(request)
    || /\b(?:other|another|previous|earlier|older|all)\b.{0,40}\b(?:email|emails|mail|message|messages|invoice|invoices|receipt|receipts)\b/.test(request);
}

function availableToolsForRequest(conversation, text) {
  if (conversation.scope !== 'email' || explicitlyRequestsMailboxSearch(text)) {
    return ASSISTANT_TOOL_DEFINITIONS;
  }
  return ASSISTANT_TOOL_DEFINITIONS.filter(definition =>
    !['mail.search', 'mail.get_thread'].includes(definition.name)
  );
}

function assistantToolDefinition(name) {
  const canonicalName = name === 'rules.create' ? 'rules.upsert' : name;
  return ASSISTANT_TOOL_DEFINITIONS.find(definition => definition.name === canonicalName);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function toolCallKey(call) {
  return `${String(call?.name || '')}:${JSON.stringify(stableValue(call?.arguments || {}))}`;
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
  const conversation = scope === 'email'
    ? getOrCreateAssistantEmailConversation({
      id: randomUUID(), account, emailItemId, title,
    })
    : insertAssistantConversation({
      id: randomUUID(), scope, account, emailItemId, title,
    });
  return getAssistantConversationEnvelope(conversation.id);
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
  if (err instanceof AssistantError && err.code === 'assistant_model_unavailable') {
    return 'Winnow’s model is temporarily unavailable. Please try again in a moment.';
  }
  if (err instanceof AssistantError && err.code === 'assistant_model_timeout') {
    return 'Winnow took too long to answer. Please try again.';
  }
  if (err instanceof AssistantError && err.code === 'assistant_model_invalid_response') {
    return 'Winnow received an incomplete model response. Please try again.';
  }
  return 'Something went wrong while Winnow was answering. Please try again.';
}

function assistantFailureCode(err) {
  if (typeof err?.code === 'string' && err.code) return err.code;
  const status = Number(err?.status || err?.statusCode || err?.response?.status || 0);
  if (status >= 400 && status <= 599) return `assistant_model_http_${status}`;
  if (/GoogleGenerativeAI/i.test(String(err?.name || ''))) return 'assistant_model_provider_error';
  return 'assistant_failed';
}

function logAssistantFailure(run, err, errorCode) {
  if (err instanceof AssistantToolError) return;
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
  const status = Number(err?.status || err?.statusCode || err?.response?.status || 0) || null;
  console.error('[assistant] run failed', {
    runId: run.id,
    errorCode,
    errorName: String(err?.name || 'Error').slice(0, 120),
    providerStatus: status,
  });
}

async function emitAssistantProgress(onProgress, event) {
  if (typeof onProgress !== 'function') return;
  try {
    await onProgress(event);
  } catch {
    // Streaming is an optional observation channel. A disconnected or failed
    // client must never interrupt the durable, idempotent assistant run.
  }
}

function acceptedEvent(run) {
  return {
    type: 'accepted',
    data: { runId: run.id, userMessageId: run.userMessageId },
  };
}

function progressEvent(stage) {
  const label = ASSISTANT_PROGRESS_LABELS[stage];
  if (!label) throw new Error('invalid_assistant_progress_stage');
  return { type: 'progress', data: { stage, label } };
}

function assistantRequestFingerprint(text) {
  return createHash('sha256').update(text.trim()).digest('base64url');
}

function assertIdempotentRequestMatches(run, requestFingerprint) {
  const storedFingerprint = run.requestFingerprint
    || assistantRequestFingerprint(getAssistantMessage(run.userMessageId)?.text || '');
  if (storedFingerprint !== requestFingerprint) {
    throw new AssistantError(
      409,
      'idempotency_key_reused',
      'This idempotency key was already used for a different assistant message',
    );
  }
}

function requireAssistantRunLease(run) {
  if (!touchAssistantRunLease(run.id, run.leaseToken)) {
    throw new AssistantError(
      409,
      'assistant_run_lease_lost',
      'This assistant request was resumed by another worker',
    );
  }
}

function startAssistantRunHeartbeat(run) {
  const timer = setInterval(() => {
    if (!touchAssistantRunLease(run.id, run.leaseToken)) clearInterval(timer);
  }, ASSISTANT_RUN_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function boundedModelResponse(model, input) {
  const request = async () => {
    let timeout;
    const providerResponse = Promise.resolve().then(() => model.respond(input));
    const deadline = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new AssistantError(
        504,
        'assistant_model_timeout',
        'The assistant model did not respond in time',
      )), assistantModelTimeoutMs);
      timeout.unref?.();
    });
    try {
      return await Promise.race([providerResponse, deadline]);
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    return await request();
  } catch (err) {
    // Gemini occasionally returns a short-lived 429/5xx response or an
    // incomplete structured candidate. Retry either once, but never retry our
    // deadline, validation, authentication, or configuration errors.
    if (!isTransientModelProviderError(err) && !isInvalidModelResponse(err)) throw err;
    try {
      return await request();
    } catch (retryErr) {
      if (isInvalidModelResponse(retryErr)) {
        throw new AssistantError(
          502,
          'assistant_model_invalid_response',
          'The assistant model returned an incomplete response',
        );
      }
      if (!isTransientModelProviderError(retryErr)) throw retryErr;
      throw new AssistantError(
        503,
        'assistant_model_unavailable',
        'The assistant model is temporarily unavailable',
      );
    }
  }
}

function isInvalidModelResponse(err) {
  return err?.code === 'assistant_model_invalid_json'
    || String(err?.message || '') === 'assistant_model_invalid_json'
    || /GoogleGenerativeAIResponseError/i.test(String(err?.name || ''));
}

function isTransientModelProviderError(err) {
  if (!err || err instanceof AssistantError) return false;
  const status = Number(err.status || err.statusCode || err.response?.status || 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  const code = String(err.code || '').toUpperCase();
  if (['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ETIMEDOUT'].includes(code)) return true;
  return /\b(?:429|50[0-9])\b|service unavailable|fetch failed|network error|socket hang up/i
    .test(String(err.message || ''));
}

async function resolveExistingAssistantRun(run, requestFingerprint, leaseToken, onProgress) {
  assertIdempotentRequestMatches(run, requestFingerprint);
  let resolved = run;
  let resumed = false;
  if (run.status === 'running') {
    const recovery = claimStaleAssistantRun(run.id, leaseToken, { leaseMs: ASSISTANT_RUN_LEASE_MS });
    resolved = recovery.run || run;
    resumed = recovery.claimed;
  }
  await emitAssistantProgress(onProgress, acceptedEvent(resolved));
  if (resumed && assistantRunHasTerminalOutput(resolved.id)) {
    completeAssistantRun(resolved.id, { leaseToken: resolved.leaseToken });
    await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.replay));
    return null;
  }
  if (resumed) {
    await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.resume));
    return resolved;
  }
  await emitAssistantProgress(onProgress, progressEvent(
    resolved.status === 'running' ? ASSISTANT_PROGRESS_STAGES.waiting : ASSISTANT_PROGRESS_STAGES.replay,
  ));
  await waitForExistingRun(resolved);
  return null;
}

export function validateAssistantMessageRequest(conversationId, { text, idempotencyKey = '' }) {
  const conversation = getAssistantConversation(conversationId);
  if (!conversation) throw new AssistantError(404, 'conversation_not_found');
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    throw new AssistantError(400, 'invalid_text', 'text must be between 1 and 4000 characters');
  }
  if (idempotencyKey && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 200)) {
    throw new AssistantError(400, 'invalid_idempotency_key');
  }
  return { conversation, normalizedText: text.trim(), idempotencyKey };
}

export async function submitAssistantMessage(
  conversationId,
  request,
  { onProgress } = {},
) {
  const { conversation, normalizedText, idempotencyKey } = validateAssistantMessageRequest(
    conversationId,
    request,
  );
  const requestFingerprint = assistantRequestFingerprint(normalizedText);
  const leaseToken = randomUUID();
  const existingRun = idempotencyKey && getAssistantRunByIdempotencyKey(conversationId, idempotencyKey);
  if (existingRun) {
    const resumed = await resolveExistingAssistantRun(
      existingRun,
      requestFingerprint,
      leaseToken,
      onProgress,
    );
    if (!resumed) return getAssistantConversationEnvelope(conversationId);
    return executeAssistantRun(resumed, conversation, normalizedText, onProgress);
  }

  const userMessageId = randomUUID();
  const requestedRunId = randomUUID();
  const run = createAssistantRunWithUserMessage({
    id: requestedRunId,
    conversationId,
    userMessageId,
    idempotencyKey,
    requestFingerprint,
    leaseToken,
    text: normalizedText,
  });
  if (run.id !== requestedRunId) {
    const resumed = await resolveExistingAssistantRun(run, requestFingerprint, leaseToken, onProgress);
    if (!resumed) return getAssistantConversationEnvelope(conversationId);
    return executeAssistantRun(resumed, conversation, normalizedText, onProgress);
  }
  await emitAssistantProgress(onProgress, acceptedEvent(run));
  return executeAssistantRun(run, conversation, normalizedText, onProgress);
}

async function executeAssistantRun(run, conversation, text, onProgress) {
  const conversationId = conversation.id;
  const toolResults = [];
  const evidence = [];
  const evidenceKeys = new Set();
  const completedToolCalls = new Set();
  const stopHeartbeat = startAssistantRunHeartbeat(run);
  try {
    requireAssistantRunLease(run);
    const dependencies = dependenciesFactory();
    const model = createAssistantModel();
    await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.context));
    const context = await contextualEmail(conversation, dependencies);
    const requestTools = availableToolsForRequest(conversation, text);
    const availableToolNames = new Set(requestTools.map(tool => tool.name));
    if (availableToolNames.has('rules.upsert')) availableToolNames.add('rules.create');
    const modelInput = finalAnswerRequired => ({
      environment: {
        currentTime: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      conversation: {
        scope: conversation.scope,
        account: conversation.account,
        contextualReference: context?.reference || null,
        finalAnswerRequired,
      },
      chatMessages: modelMessages(listAssistantMessages(conversationId)),
      contextualEmail: context,
      toolResults,
      availableTools: finalAnswerRequired ? [] : requestTools,
    });
    const appendEvidence = items => {
      for (const item of items || []) {
        const identity = [item.account, item.emailItemId, item.messageId, item.threadId]
          .map(value => String(value || ''));
        const key = identity.some(Boolean)
          ? identity.join('\u0000')
          : JSON.stringify(stableValue(item));
        if (evidenceKeys.has(key)) continue;
        evidenceKeys.add(key);
        evidence.push(item);
      }
    };
    const finishWithResponse = response => {
      requireAssistantRunLease(run);
      finishAssistantRunWithMessage({
        runId: run.id,
        leaseToken: run.leaseToken,
        message: {
          id: randomUUID(), conversationId, role: 'assistant',
          text: response?.text || 'I could not find that detail in the available email context.',
          evidence, draft: normalizeDraft(response?.draft),
        },
      });
    };
    let response = null;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.model));
      response = await boundedModelResponse(model, modelInput(false));
      requireAssistantRunLease(run);
      await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.modelComplete));
      const calls = Array.isArray(response?.toolCalls) ? response.toolCalls.slice(0, 3) : [];
      if (!calls.length) {
        finishWithResponse(response);
        await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.finalizing));
        return getAssistantConversationEnvelope(conversationId);
      }

      let proposed = false;
      // Execute read/reversible work before creating the first proposal. This
      // makes compound requests such as "archive this and future messages"
      // deterministic even if the model returns the proposal call first.
      const orderedCalls = calls.map((call, index) => ({ call, index })).sort((left, right) => {
        const risk = entry => assistantToolDefinition(entry.call.name)?.risk;
        const priority = entry => ['read', 'reversible'].includes(risk(entry)) ? 0 : 1;
        return priority(left) - priority(right) || left.index - right.index;
      }).map(entry => entry.call);
      for (const call of orderedCalls) {
        const callId = randomUUID();
        const definition = assistantToolDefinition(call.name);
        try {
          requireAssistantRunLease(run);
          await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.tool));
          if (!availableToolNames.has(call.name)) {
            throw new AssistantToolError(
              'tool_not_available_for_request',
              'Answer from the selected email context; mailbox search was not requested',
              400,
            );
          }
          const callKey = toolCallKey(call);
          if (['read', 'reversible'].includes(definition?.risk) && completedToolCalls.has(callKey)) {
            throw new AssistantToolError(
              'duplicate_tool_call',
              'This read tool already ran with the same arguments; use its existing result',
              400,
            );
          }
          const prepared = await prepareAssistantTool({
            name: call.name,
            rawArguments: call.arguments,
            conversation,
            latestUserText: text,
            dependencies,
          });
          requireAssistantRunLease(run);
          appendEvidence(prepared.evidence);
          if (prepared.kind === 'proposal') {
            const identity = createProposalIdentity();
            const proposalInput = {
              ...identity,
              conversationId,
              tool: call.name,
              arguments: prepared.arguments,
            };
            const confirmationDigest = assistantProposalDigest(proposalInput);
            const finished = finishAssistantRunWithProposal({
              runId: run.id,
              leaseToken: run.leaseToken,
              proposal: {
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
              },
              toolCall: {
                id: callId, runId: run.id, proposalId: identity.id,
                tool: call.name, risk: prepared.risk, arguments: prepared.arguments, status: 'proposed',
              },
              message: {
                id: randomUUID(), conversationId, role: 'assistant',
                text: response?.text || prepared.summary,
                evidence, draft: normalizeDraft(response?.draft), proposalId: identity.id,
              },
            });
            if (!finished) throw new AssistantError(409, 'assistant_run_lease_lost');
            await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.confirmation));
            proposed = true;
            break;
          }
          recordAssistantToolCall({
            id: callId, runId: run.id, tool: call.name, risk: prepared.risk,
            arguments: call.arguments, result: safeToolAudit(prepared), status: 'completed',
          });
          if (['read', 'reversible'].includes(definition?.risk)) completedToolCalls.add(callKey);
          toolResults.push({ tool: call.name, result: prepared.result, trust: 'untrusted_tool_data' });
          await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.toolComplete));
        } catch (err) {
          if (err instanceof AssistantError && err.code === 'assistant_run_lease_lost') throw err;
          recordAssistantToolCall({
            id: callId, runId: run.id, tool: call.name,
            risk: assistantToolDefinition(call.name)?.risk || 'read',
            arguments: rejectedToolAudit(call.arguments), result: { error: err.code || 'tool_failed' }, status: 'failed',
          });
          if (err instanceof AssistantToolError
              && ['duplicate_tool_call', 'tool_not_available_for_request'].includes(err.code)) {
            toolResults.push({
              tool: call.name,
              result: { error: err.code, message: err.message },
              trust: 'untrusted_tool_data',
            });
            await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.toolComplete));
            continue;
          }
          throw err;
        }
      }
      if (proposed) {
        await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.finalizing));
        return getAssistantConversationEnvelope(conversationId);
      }
    }

    // A bounded tool loop should end with synthesis, not a user-facing limit
    // error. Remove all tools for one final model turn so it must answer from
    // the selected email and the evidence already gathered.
    await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.model));
    response = await boundedModelResponse(model, modelInput(true));
    requireAssistantRunLease(run);
    await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.modelComplete));
    finishWithResponse(response);
    await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.finalizing));
    return getAssistantConversationEnvelope(conversationId);
  } catch (err) {
    if (err instanceof AssistantError && err.code === 'assistant_run_lease_lost') throw err;
    requireAssistantRunLease(run);
    const errorCode = assistantFailureCode(err);
    logAssistantFailure(run, err, errorCode);
    finishAssistantRunWithMessage({
      runId: run.id,
      leaseToken: run.leaseToken,
      status: 'failed',
      errorCode,
      message: {
        id: randomUUID(), conversationId, role: 'assistant', text: errorText(err), evidence,
      },
    });
    await emitAssistantProgress(onProgress, progressEvent(ASSISTANT_PROGRESS_STAGES.finalizing));
    return getAssistantConversationEnvelope(conversationId);
  } finally {
    stopHeartbeat();
  }
}

export async function confirmAssistantProposal(id, confirmationDigest) {
  if (typeof confirmationDigest !== 'string' || !confirmationDigest) {
    throw new AssistantError(400, 'confirmation_digest_required');
  }
  const existing = getAssistantProposal(id);
  if (existing && CLIENT_ASSISTANT_TOOLS.has(existing.tool)) {
    throw new AssistantError(400, 'proposal_requires_ios_completion');
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

export function completeAssistantClientProposal(id, confirmationDigest) {
  if (typeof confirmationDigest !== 'string' || !confirmationDigest) {
    throw new AssistantError(400, 'confirmation_digest_required');
  }
  const existing = getAssistantProposal(id);
  if (!existing) throw new AssistantError(404, 'proposal_not_found');
  if (!CLIENT_ASSISTANT_TOOLS.has(existing.tool)) {
    throw new AssistantError(400, 'proposal_not_client_action');
  }
  const claimed = claimAssistantProposal(id, confirmationDigest);
  if (!claimed.claimed) {
    if (claimed.reason === 'completed') {
      return getAssistantConversationEnvelope(existing.conversationId);
    }
    const status = claimed.reason === 'digest_mismatch' ? 403 : 409;
    throw new AssistantError(status, `proposal_${claimed.reason}`);
  }

  finishAssistantProposal(id, { status: 'completed', result: { ok: true, completedBy: 'ios' } });
  const text = existing.tool === 'device.create_reminder'
    ? 'Added to Reminders.'
    : existing.tool === 'device.create_calendar_event'
      ? 'Added to Calendar.'
      : 'Contact selected.';
  addAssistantMessage({
    id: randomUUID(), conversationId: existing.conversationId, role: 'assistant', text,
  });
  return getAssistantConversationEnvelope(existing.conversationId);
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
