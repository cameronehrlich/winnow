import { scan } from './scan.js';
import { getActiveAccounts, getScanSearchQuery, loadConfig } from './config.js';
import { startActionListener, stopActionListener } from './slack-actions.js';
import { startApiServer } from './api.js';
import { refreshMailboxes } from './mailbox-sync.js';
import { ensureStore } from './store.js';

const DEFAULT_SCAN_INTERVAL_SEC = 30;

function interval(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDaemonIntervals(opts = {}, config = {}) {
  return {
    scanIntervalSec: interval(opts.interval ?? config.daemon?.scan_interval_seconds, DEFAULT_SCAN_INTERVAL_SEC),
    syncIntervalSec: interval(config.daemon?.sync_interval_seconds, 30),
  };
}

async function runScanCycle(accounts, searchQuery) {
  for (const account of accounts) {
    try {
      await scan(account, { searchQuery });
    } catch (err) {
      console.error(`[winnow/daemon] Scan error (${account}): ${err.message}`);
    }
  }
}

function startSlackActionsInBackground() {
  startActionListener().catch(err => {
    console.error(`[winnow/daemon] Slack action listener failed: ${err.message}`);
  });
}

function guarded(fn, label) {
  let running = false;
  return async () => {
    if (running) {
      console.warn(`[winnow/daemon] Previous ${label} cycle still running — skipping tick`);
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}

export async function startDaemon(opts = {}) {
  ensureStore();
  const config = loadConfig();
  const accounts = getActiveAccounts().map(a => a.email);
  const { scanIntervalSec, syncIntervalSec } = resolveDaemonIntervals(opts, config);
  const scanSearchQuery = getScanSearchQuery(config);

  if (!accounts.length) throw new Error('No accounts configured');

  console.log(`[winnow/daemon] Starting daemon for accounts: ${accounts.join(', ')}`);
  const apiServer = await startApiServer();
  startSlackActionsInBackground();

  const scanCycle = guarded(() => runScanCycle(accounts, scanSearchQuery), 'scan');
  // History sync includes cursor-expiry/daily snapshot recovery. Do not run
  // hundreds of redundant per-message repair reads ahead of the next tick.
  const syncCycle = guarded(() => refreshMailboxes(), 'sync');

  const scanTimer = setInterval(scanCycle, scanIntervalSec * 1000);
  const syncTimer = setInterval(syncCycle, syncIntervalSec * 1000);
  void scanCycle();
  void syncCycle();

  const shutdown = async (sig) => {
    console.log(`\n[winnow/daemon] ${sig} received — stopping daemon`);
    clearInterval(scanTimer);
    clearInterval(syncTimer);
    await stopActionListener();
    await new Promise(resolve => apiServer.close(resolve));
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
