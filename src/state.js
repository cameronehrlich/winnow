import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, findEmailItemByGmail } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_PATH = join(__dirname, '..', 'data', 'state.json');
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const CLAIM_TTL_MS = 10 * 60 * 1000;
const STATE_TIME_ZONE = 'America/Los_Angeles';

function statePath() {
  return process.env.WINNOW_STATE_PATH || DEFAULT_STATE_PATH;
}

const DEFAULT_STATE = {
  processedIds: [],
  processingIds: {},
  lastScanTime: null,
  lastScanByAccount: {},
  lastScanCountsByAccount: {},
  scanResults: [],
  stats: {
    totalProcessed: 0,
    byPriority: { low: 0, normal: 0, urgent: 0 },
    lowConfidenceBumps: 0,
    unsubscribes: {
      total: 0,
      byStatus: { succeeded: 0, failed: 0, attempted: 0 },
      entries: [],
      daily: {},
    },
  },
};

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

export function localDateString(dateLike = Date.now(), timeZone = STATE_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(dateLike));
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normalizeState(state) {
  const defaults = cloneDefaultState();
  const normalized = {
    ...defaults,
    ...(state && typeof state === 'object' ? state : {}),
    stats: {
      ...defaults.stats,
      ...(state?.stats && typeof state.stats === 'object' ? state.stats : {}),
      unsubscribes: {
        ...defaults.stats.unsubscribes,
        ...(state?.stats?.unsubscribes && typeof state.stats.unsubscribes === 'object'
          ? state.stats.unsubscribes
          : {}),
      },
    },
  };

  if (!Array.isArray(normalized.processedIds)) normalized.processedIds = [];
  if (!normalized.processingIds || typeof normalized.processingIds !== 'object' || Array.isArray(normalized.processingIds)) {
    normalized.processingIds = {};
  }
  if (!normalized.lastScanByAccount || typeof normalized.lastScanByAccount !== 'object' || Array.isArray(normalized.lastScanByAccount)) {
    normalized.lastScanByAccount = {};
  }
  if (!normalized.lastScanCountsByAccount || typeof normalized.lastScanCountsByAccount !== 'object' || Array.isArray(normalized.lastScanCountsByAccount)) {
    normalized.lastScanCountsByAccount = {};
  }
  if (!Array.isArray(normalized.scanResults)) normalized.scanResults = [];
  if (!normalized.stats.byPriority) normalized.stats.byPriority = { low: 0, normal: 0, urgent: 0 };
  if (!Array.isArray(normalized.stats.unsubscribes.entries)) normalized.stats.unsubscribes.entries = [];
  if (!normalized.stats.unsubscribes.byStatus) {
    normalized.stats.unsubscribes.byStatus = { succeeded: 0, failed: 0, attempted: 0 };
  }
  if (!normalized.stats.unsubscribes.daily) normalized.stats.unsubscribes.daily = {};

  return normalized;
}

export function loadState() {
  try {
    const raw = readFileSync(statePath(), 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch {
    return cloneDefaultState();
  }
}

export function saveState(state) {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmpPath, path);
}

export function updateState(mutator) {
  return withStateLock(() => {
    const state = loadState();
    cleanupExpiredClaims(state);
    const result = mutator(state);
    saveState(state);
    return result;
  });
}

function lockPath() {
  return `${statePath()}.lock`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStateLock(fn) {
  const path = lockPath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(path), { recursive: true });

  while (true) {
    try {
      mkdirSync(path);
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for state lock: ${path}`);
      }
      sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function cleanupExpiredClaims(state) {
  const processingIds = state.processingIds || {};
  const cutoff = Date.now() - CLAIM_TTL_MS;
  for (const [messageId, claimedAt] of Object.entries(processingIds)) {
    if (!messageId) continue;
    const ts = Date.parse(claimedAt);
    if (!Number.isFinite(ts) || ts < cutoff) {
      delete processingIds[messageId];
    }
  }
  state.processingIds = processingIds;
}

export function isProcessed(messageId) {
  if (!messageId) return false;
  const state = loadState();
  return state.processedIds.includes(messageId);
}

export function claimProcessing(messageId) {
  if (!messageId) return false;
  return withStateLock(() => {
    const state = loadState();
    cleanupExpiredClaims(state);
    if (state.processedIds.includes(messageId) || state.processingIds[messageId]) {
      return false;
    }
    state.processingIds[messageId] = new Date().toISOString();
    saveState(state);
    return true;
  });
}

export function releaseProcessing(messageId) {
  if (!messageId) return false;
  return withStateLock(() => {
    const state = loadState();
    cleanupExpiredClaims(state);
    if (!state.processingIds[messageId]) return false;
    delete state.processingIds[messageId];
    saveState(state);
    return true;
  });
}

export function markProcessed(messageId, result) {
  if (!messageId) return;
  withStateLock(() => {
    const state = loadState();
    cleanupExpiredClaims(state);

    if (!state.processedIds.includes(messageId)) {
      state.processedIds.push(messageId);
    }
    delete state.processingIds[messageId];

    if (result) {
      state.scanResults.push({
        ...result,
        messageId,
        processedAt: new Date().toISOString(),
      });

      const priority = result.priority || (result.archive ? 'low' : 'normal');
      state.stats.totalProcessed++;
      state.stats.byPriority[priority] = (state.stats.byPriority[priority] || 0) + 1;
      if (result.bumped) state.stats.lowConfidenceBumps++;
      if (result.ephemeral) state.stats.ephemeralCount = (state.stats.ephemeralCount || 0) + 1;

      // Daily stats tracking
      const today = localDateString();
      if (!state.stats.daily) state.stats.daily = {};
      if (!state.stats.daily[today]) state.stats.daily[today] = {};
      const day = state.stats.daily[today];
      if (!day.byPriority) day.byPriority = { low: 0, normal: 0, urgent: 0 };
      if (!day.rulesTriggered) day.rulesTriggered = {};
      day.processed = day.processed || 0;
      day.ephemeral = day.ephemeral || 0;
      day.bumped = day.bumped || 0;
      day.scansRun = day.scansRun || 0;

      day.processed++;
      day.byPriority[priority] = (day.byPriority[priority] || 0) + 1;
      if (result.ephemeral) day.ephemeral++;
      if (result.bumped) day.bumped++;
    }

    state.lastScanTime = new Date().toISOString();
    saveState(state);
  });
}

export function recordUnsubscribe(entry) {
  const now = new Date().toISOString();
  const { normalized, isDuplicateEvent } = updateState(state => {
    if (!state.stats) state.stats = {};
    if (!state.stats.unsubscribes) {
      state.stats.unsubscribes = {
        total: 0,
        byStatus: { succeeded: 0, failed: 0, attempted: 0 },
        entries: [],
        daily: {},
      };
    }

    const unsubscribes = state.stats.unsubscribes;
    if (!Array.isArray(unsubscribes.entries)) unsubscribes.entries = [];
    if (!unsubscribes.byStatus) unsubscribes.byStatus = { succeeded: 0, failed: 0, attempted: 0 };
    if (!unsubscribes.daily) unsubscribes.daily = {};

    const normalized = {
      id: entry.id || `unsub-${Date.now()}`,
      timestamp: entry.timestamp || now,
      status: entry.status || 'succeeded',
      sender: entry.sender || '',
      subject: entry.subject || '',
      account: entry.account || '',
      threadId: entry.threadId || '',
      source: entry.source || 'manual',
      method: entry.method || 'unknown',
      note: entry.note || '',
      sourceMessageId: entry.sourceMessageId || '',
      urlHost: entry.urlHost || '',
    };

    const existingIndex = unsubscribes.entries.findIndex(e =>
      (normalized.sourceMessageId && e.sourceMessageId === normalized.sourceMessageId) ||
      (normalized.threadId && normalized.sender && e.threadId === normalized.threadId && e.sender === normalized.sender) ||
      (e.id === normalized.id)
    );

    const previous = existingIndex >= 0 ? unsubscribes.entries[existingIndex] : null;
    if (previous?.id) normalized.id = previous.id;
    const isDuplicateEvent = previous
      && previous.status === normalized.status
      && previous.method === normalized.method
      && previous.note === normalized.note
      && previous.source === normalized.source;
    if (isDuplicateEvent && previous?.timestamp) normalized.timestamp = previous.timestamp;

    if (existingIndex >= 0) {
      unsubscribes.entries[existingIndex] = { ...unsubscribes.entries[existingIndex], ...normalized };
    } else {
      unsubscribes.entries.push(normalized);
    }

    // Recompute counters from entries so backfills/updates stay consistent.
    unsubscribes.total = unsubscribes.entries.length;
    unsubscribes.byStatus = { succeeded: 0, failed: 0, attempted: 0 };
    unsubscribes.daily = {};
    for (const e of unsubscribes.entries) {
      const status = e.status || 'succeeded';
      unsubscribes.byStatus[status] = (unsubscribes.byStatus[status] || 0) + 1;
      const day = localDateString(e.timestamp || now);
      if (!unsubscribes.daily[day]) unsubscribes.daily[day] = { total: 0, byStatus: {} };
      unsubscribes.daily[day].total++;
      unsubscribes.daily[day].byStatus[status] = (unsubscribes.daily[day].byStatus[status] || 0) + 1;
    }

    return { normalized, isDuplicateEvent };
  });

  if (isDuplicateEvent) return normalized;

  const existing = normalized.account || normalized.threadId
    ? findEmailItemByGmail({ account: normalized.account, threadId: normalized.threadId })
    : null;
  const eventType = normalized.status === 'failed'
    ? 'email.unsubscribe_failed'
    : normalized.status === 'attempted'
      ? 'email.unsubscribe_attempted'
      : 'email.unsubscribed';
  appendEvent({
    eventType,
    source: normalized.source || 'manual',
    account: normalized.account || existing?.account || '',
    emailItemId: existing?.id || '',
    messageId: existing?.messageId || '',
    threadId: normalized.threadId || existing?.threadId || '',
    timestamp: normalized.timestamp,
    reason: normalized.note || normalized.status,
    metadata: normalized,
  });
  return normalized;
}

export function getUnsubscribes() {
  const state = loadState();
  return state.stats?.unsubscribes || {
    total: 0,
    byStatus: { succeeded: 0, failed: 0, attempted: 0 },
    entries: [],
    daily: {},
  };
}

export function findUnsubscribeBySourceMessageId(sourceMessageId) {
  if (!sourceMessageId) return null;
  const entries = getUnsubscribes().entries || [];
  return entries.find(entry => entry.sourceMessageId === sourceMessageId) || null;
}

export function findUnsubscribeForEmail({ account = '', threadId = '', sender = '' } = {}) {
  if (!account || !threadId) return null;
  const entries = getUnsubscribes().entries || [];
  return entries.find(entry => (
    entry.account === account
    && entry.threadId === threadId
    && (!sender || !entry.sender || entry.sender === sender)
  )) || null;
}

export function getStats() {
  const state = loadState();
  return {
    ...state.stats,
    lastScanTime: state.lastScanTime,
  };
}

export function pruneOldResults(daysToKeep = 7) {
  updateState(state => {
    const cutoff = new Date(Date.now() - daysToKeep * 86400000).toISOString();
    state.scanResults = state.scanResults.filter(r => r.processedAt > cutoff);

    // Also prune processedIds to prevent unbounded growth — keep last 5000
    if (state.processedIds.length > 5000) {
      state.processedIds = state.processedIds.slice(-5000);
    }
  });
}
