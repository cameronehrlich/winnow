import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, '..', 'data', 'state.json');

const DEFAULT_STATE = {
  processedIds: [],
  lastScanTime: null,
  lastDigestTime: null,
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
    const raw = readFileSync(STATE_PATH, 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch {
    return cloneDefaultState();
  }
}

export function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmpPath = STATE_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmpPath, STATE_PATH);
}

export function isProcessed(messageId) {
  if (!messageId) return false;
  const state = loadState();
  return state.processedIds.includes(messageId);
}

export function markProcessed(messageId, result) {
  if (!messageId) return;
  const state = loadState();

  if (!state.processedIds.includes(messageId)) {
    state.processedIds.push(messageId);
  }

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
    const today = new Date().toISOString().split('T')[0];
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
}

export function getResultsSinceLastDigest() {
  const state = loadState();
  const since = state.lastDigestTime;
  let results = since
    ? state.scanResults.filter(r => r.processedAt > since)
    : state.scanResults;

  // Deduplicate by messageId — keep the latest entry (most recent classification)
  const seen = new Map();
  for (const r of results) {
    seen.set(r.messageId, r);
  }
  return Array.from(seen.values());
}

export function markDigestSent() {
  const state = loadState();
  state.lastDigestTime = new Date().toISOString();
  saveState(state);
}

export function recordUnsubscribe(entry) {
  const state = loadState();
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

  const now = new Date().toISOString();
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
    const day = (e.timestamp || now).slice(0, 10);
    if (!unsubscribes.daily[day]) unsubscribes.daily[day] = { total: 0, byStatus: {} };
    unsubscribes.daily[day].total++;
    unsubscribes.daily[day].byStatus[status] = (unsubscribes.daily[day].byStatus[status] || 0) + 1;
  }

  saveState(state);
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

export function getStats() {
  const state = loadState();
  return {
    ...state.stats,
    lastScanTime: state.lastScanTime,
    lastDigestTime: state.lastDigestTime,
  };
}

export function pruneOldResults(daysToKeep = 7) {
  const state = loadState();
  const cutoff = new Date(Date.now() - daysToKeep * 86400000).toISOString();
  state.scanResults = state.scanResults.filter(r => r.processedAt > cutoff);

  // Also prune processedIds to prevent unbounded growth — keep last 5000
  if (state.processedIds.length > 5000) {
    state.processedIds = state.processedIds.slice(-5000);
  }

  saveState(state);
}
