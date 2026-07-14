import { scan } from './scan.js';
import { getAccounts, getScanSearchQuery, loadConfig } from './config.js';
import { startActionListener, stopActionListener } from './slack-actions.js';
import { startApiServer } from './api.js';
import { reconcileMailbox } from './reconcile.js';
import { syncGmailMailbox } from './gmail-sync.js';
import { ensureStore } from './store.js';
import { sendBadgeSync } from './push.js';

const DEFAULT_SCAN_INTERVAL_SEC = 30;
const DEFAULT_RECONCILE_INTERVAL_SEC = 300;

function interval(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDaemonIntervals(opts = {}, config = {}) {
  return {
    scanIntervalSec: interval(opts.interval ?? config.daemon?.scan_interval_seconds, DEFAULT_SCAN_INTERVAL_SEC),
    reconcileIntervalSec: interval(config.reconcile?.interval_seconds, DEFAULT_RECONCILE_INTERVAL_SEC),
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

async function runReconcileCycle(accounts) {
  let badgeMayHaveChanged = false;
  for (const account of accounts) {
    try {
      const syncResult = await syncGmailMailbox(account);
      if (syncResult.imported > 0 || syncResult.classified > 0 || syncResult.changed > 0) {
        console.log(
          `[winnow/daemon] Gmail ${syncResult.mode} sync for ${account}: `
          + `${syncResult.imported} imported, ${syncResult.classified} classified, ${syncResult.changed} updated`,
        );
      }
      badgeMayHaveChanged ||= syncResult.changed > 0;
    } catch (err) {
      console.error(`[winnow/daemon] Gmail sync error (${account}): ${err.message}`);
    }
  }

  // Run the slower per-message verification only after every account has had
  // its lightweight history/full sync, so one large mailbox cannot delay
  // catch-up for the accounts that follow it.
  for (const account of accounts) {
    try {
      const result = await reconcileMailbox({ account, days: 7, limit: 100 });
      if (result.changed > 0) {
        console.log(`[winnow/daemon] Reconciled ${result.changed}/${result.checked} mailbox state changes for ${account}`);
        badgeMayHaveChanged = true;
      }
    } catch (err) {
      console.error(`[winnow/daemon] Reconcile error (${account}): ${err.message}`);
    }
  }
  if (badgeMayHaveChanged) await sendBadgeSync();
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
  const { scanIntervalSec, reconcileIntervalSec } = resolveDaemonIntervals(opts, config);
  const scanSearchQuery = getScanSearchQuery(config);

  if (!accounts.length) throw new Error('No accounts configured');

  console.log(`[winnow/daemon] Starting daemon for accounts: ${accounts.join(', ')}`);
  const apiServer = await startApiServer();
  startSlackActionsInBackground();

  const scanCycle = guarded(() => runScanCycle(accounts, scanSearchQuery), 'scan');
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
