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
  },
};

export function loadState() {
  try {
    const raw = readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmpPath = STATE_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmpPath, STATE_PATH);
}

export function isProcessed(messageId) {
  const state = loadState();
  return state.processedIds.includes(messageId);
}

export function markProcessed(messageId, result) {
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

    state.stats.totalProcessed++;
    state.stats.byPriority[result.priority] = (state.stats.byPriority[result.priority] || 0) + 1;
    if (result.bumped) state.stats.lowConfidenceBumps++;
    if (result.ephemeral) state.stats.ephemeralCount = (state.stats.ephemeralCount || 0) + 1;

    // Daily stats tracking
    const today = new Date().toISOString().split('T')[0];
    if (!state.stats.daily) state.stats.daily = {};
    if (!state.stats.daily[today]) {
      state.stats.daily[today] = {
        processed: 0,
        byPriority: { low: 0, normal: 0, urgent: 0 },
        ephemeral: 0,
        bumped: 0,
        scansRun: 0,
        rulesTriggered: {},
      };
    }
    const day = state.stats.daily[today];
    day.processed++;
    day.byPriority[result.priority] = (day.byPriority[result.priority] || 0) + 1;
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
