import { scan } from './scan.js';
import { getAccounts, loadConfig } from './config.js';
import { startActionListener, stopActionListener } from './slack-actions.js';
import { startApiServer } from './api.js';
import { reconcileMailbox } from './reconcile.js';
import { ensureStore } from './store.js';

const DEFAULT_SCAN_INTERVAL_SEC = 30;
const DEFAULT_RECONCILE_INTERVAL_SEC = 300;

function interval(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runScanCycle(accounts) {
  for (const account of accounts) {
    try {
      await scan(account, { searchQuery: 'in:inbox is:unread newer_than:1h' });
    } catch (err) {
      console.error(`[winnow/daemon] Scan error (${account}): ${err.message}`);
    }
  }
}

async function runReconcileCycle(accounts) {
  for (const account of accounts) {
    try {
      const result = await reconcileMailbox({ account, days: 7, limit: 100 });
      if (result.changed > 0) {
        console.log(`[winnow/daemon] Reconciled ${result.changed}/${result.checked} mailbox state changes for ${account}`);
      }
    } catch (err) {
      console.error(`[winnow/daemon] Reconcile error (${account}): ${err.message}`);
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
  const accounts = getAccounts().map(a => a.email);
  const scanIntervalSec = interval(opts.interval ?? config.daemon?.scan_interval_seconds, DEFAULT_SCAN_INTERVAL_SEC);
  const reconcileIntervalSec = interval(config.reconcile?.interval_seconds, DEFAULT_RECONCILE_INTERVAL_SEC);

  if (!accounts.length) throw new Error('No accounts configured');

  console.log(`[winnow/daemon] Starting daemon for accounts: ${accounts.join(', ')}`);
  const apiServer = await startApiServer();
  startSlackActionsInBackground();

  const scanCycle = guarded(() => runScanCycle(accounts), 'scan');
  const reconcileCycle = guarded(() => runReconcileCycle(accounts), 'reconcile');

  await scanCycle();
  await reconcileCycle();

  const scanTimer = setInterval(scanCycle, scanIntervalSec * 1000);
  const reconcileTimer = setInterval(reconcileCycle, reconcileIntervalSec * 1000);

  const shutdown = async (sig) => {
    console.log(`\n[winnow/daemon] ${sig} received — stopping daemon`);
    clearInterval(scanTimer);
    clearInterval(reconcileTimer);
    await stopActionListener();
    await new Promise(resolve => apiServer.close(resolve));
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
