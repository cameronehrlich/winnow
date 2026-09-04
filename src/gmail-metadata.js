import { GogAdapter, normalizeGogMessage } from './adapters/gog.js';
import {
  deleteGmailMessageMetadata,
  getGmailMessageMetadata,
  listSentThreadRepresentatives,
  upsertGmailMessageMetadata,
} from './store.js';

const MAX_SENT_SEARCH = 100;
const MIN_SENT_BACKFILL = 50;
const HYDRATION_CONCURRENCY = 4;
// The native client requests 50 rows. Hydrate that complete first page while
// keeping larger API requests bounded to the same fixed provider-call budget.
const MAX_RESPONSE_HYDRATIONS = 50;

export function indexGmailMessageMetadata(account, value, { assumeSent = false } = {}) {
  const message = normalizeGogMessage(value, { includeBody: false });
  if (!message.id) throw new TypeError('Cannot index Gmail metadata without a message ID');
  if (assumeSent && !message.labelIds.includes('SENT') && !message.labelIds.includes('DRAFT')) {
    message.labelIds = [...message.labelIds, 'SENT'];
  }
  return upsertGmailMessageMetadata(account, message);
}

export function indexThreadContentMetadata(content) {
  if (!content?.account || !Array.isArray(content.messages)) return [];
  const indexed = [];
  for (const message of content.messages) {
    if (!message?.id && !message?.messageId) continue;
    indexed.push(upsertGmailMessageMetadata(content.account, {
      ...message,
      threadId: content.threadId || message.threadId,
    }));
  }
  return indexed;
}

function needsHydration(message) {
  return !message?.threadId
    || !message?.to
    || (!message?.internalDate && !message?.date)
    || (!message?.subject && !message?.snippet);
}

async function mapWithConcurrency(values, concurrency, callback) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      await callback(values[index], index);
    }
  });
  await Promise.all(workers);
}

function isMissingMessageError(error) {
  return /(?:\b404\b|notFound|message.*(?:not found|does not exist)|requested entity was not found)/i
    .test(String(error?.stderr || error?.message || error || ''));
}

async function indexRecentSentSummaries({ account, limit, adapter }) {
  const response = await adapter.searchMailbox(account, 'in:sent', limit);
  const summaries = Array.isArray(response?.messages) ? response.messages.slice(0, limit) : [];
  const indexed = [];
  for (const summary of summaries) {
    if (!summary?.id && !summary?.messageId) continue;
    indexed.push(indexGmailMessageMetadata(account, summary, { assumeSent: true }));
  }
  return indexed;
}

async function hydrateIndexedMessages(messages, { adapter, strict }) {
  const failures = [];
  await mapWithConcurrency(messages, HYDRATION_CONCURRENCY, async message => {
    try {
      const full = normalizeGogMessage(
        await adapter.getMessage(message.account, message.messageId),
        { includeBody: false },
      );
      if (!full.id || full.id !== message.messageId) {
        throw new Error('Gmail returned an incomplete or mismatched Sent message');
      }
      indexGmailMessageMetadata(message.account, full, { assumeSent: true });
    } catch (error) {
      if (isMissingMessageError(error)) {
        deleteGmailMessageMetadata(message.account, message.messageId);
        return;
      }
      if (strict) throw error;
      failures.push({ account: message.account, messageId: message.messageId });
      // Do not leak provider output or fail the entire mailbox because one old
      // message disappeared. Its cheap search metadata remains usable.
      console.error(`[winnow/sent] Could not hydrate ${message.account} message ${message.messageId}: ${error.message}`);
    }
  });
  return failures;
}

/**
 * Refresh the leading edge of Sent on every request and hydrate only cache
 * misses. A single inaccessible message does not make the entire mailbox
 * unavailable; its search metadata is still cached when usable.
 */
export async function listSentMailbox({
  accounts,
  limit = 50,
  adapter = new GogAdapter(),
} = {}) {
  const normalizedAccounts = Array.from(new Set((accounts || [])
    .map(account => String(account || '').trim().toLowerCase())
    .filter(Boolean)));
  const searchLimit = Math.min(MAX_SENT_SEARCH, Math.max(MIN_SENT_BACKFILL, limit * 3));
  const searchResults = [];
  await mapWithConcurrency(normalizedAccounts, HYDRATION_CONCURRENCY, async (account, index) => {
    try {
      searchResults[index] = {
        account,
        messages: await indexRecentSentSummaries({ account, limit: searchLimit, adapter }),
      };
    } catch (error) {
      searchResults[index] = { account, error };
    }
  });
  const searchFailures = searchResults.filter(result => result.error);
  const cachedRepresentatives = listSentThreadRepresentatives({ accounts: normalizedAccounts, limit });
  if (
    searchFailures.length > 0
    && searchFailures.length === normalizedAccounts.length
    && cachedRepresentatives.length === 0
  ) throw searchFailures[0].error;
  const healthyAccounts = searchResults.filter(result => !result.error).map(result => result.account);

  const representatives = cachedRepresentatives;
  const missingRepresentatives = representatives
    .filter(message => healthyAccounts.includes(message.account) && needsHydration(message));
  const hydrationFailures = await hydrateIndexedMessages(
    missingRepresentatives.slice(0, MAX_RESPONSE_HYDRATIONS),
    { adapter, strict: false },
  );

  return {
    items: listSentThreadRepresentatives({ accounts: normalizedAccounts, limit }),
    accounts: normalizedAccounts,
    accountErrors: searchFailures.map(result => ({
      account: result.account,
      error: 'sent_search_unavailable',
    })),
    hydrationFailures: hydrationFailures.length,
    deferredHydrationCount: Math.max(0, missingRepresentatives.length - MAX_RESPONSE_HYDRATIONS),
    fetchedAt: new Date().toISOString(),
  };
}

export async function backfillRecentSentMetadata({
  account,
  limit = MIN_SENT_BACKFILL,
  adapter = new GogAdapter(),
  strict = false,
} = {}) {
  const searchLimit = Math.min(MAX_SENT_SEARCH, Math.max(1, Number(limit) || MIN_SENT_BACKFILL));
  const summaries = await indexRecentSentSummaries({ account, limit: searchLimit, adapter });
  const representatives = listSentThreadRepresentatives({ accounts: [account], limit: searchLimit });
  const hydrate = representatives.filter(needsHydration);
  const failures = await hydrateIndexedMessages(hydrate, { adapter, strict });
  return { searched: summaries.length, hydrated: hydrate.length, failures: failures.length };
}

export function getIndexedGmailMessage(account, messageId) {
  return getGmailMessageMetadata(account, messageId);
}
