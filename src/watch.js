import { scan } from './scan.js';
import { getAccounts, getScanSearchQuery, loadConfig } from './config.js';
import { startActionListener, stopActionListener } from './slack-actions.js';

const DEFAULT_INTERVAL_SEC = 30;

export async function watch(opts = {}) {
  const accounts = getAccounts();
  const intervalSec = Number.isFinite(opts.interval) && opts.interval > 0
    ? opts.interval
    : DEFAULT_INTERVAL_SEC;

  if (accounts.length === 0) {
    console.error('[winnow] No accounts configured');
    process.exit(1);
  }

  const emails = accounts.map(a => a.email);
  const searchQuery = getScanSearchQuery(loadConfig());
  console.log(`[winnow] 👁️  Watch mode started — polling every ${intervalSec}s`);
  console.log(`[winnow] Accounts: ${emails.join(', ')}`);

  // Start Slack button action listener without blocking inbox scans.
  startActionListener().catch(err => {
    console.error(`[winnow] Slack action listener failed: ${err.message}`);
  });

  let running = false;
  const runGuardedCycle = async () => {
    if (running) {
      console.warn('[winnow] Previous scan cycle still running — skipping this tick');
      return;
    }
    running = true;
    try {
      await runCycle(emails, searchQuery);
    } finally {
      running = false;
    }
  };

  // Run initial scan immediately
  await runGuardedCycle();

  // Then poll on interval
  const timer = setInterval(runGuardedCycle, intervalSec * 1000);

  // Graceful shutdown
  const shutdown = async (sig) => {
    console.log(`\n[winnow] ${sig} received — stopping watch`);
    clearInterval(timer);
    await stopActionListener();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runCycle(accounts, searchQuery) {
  for (const account of accounts) {
    try {
      const results = await scan(account, { searchQuery });
      if (results.length > 0) {
        const archived = results.filter(r => r.archive).length;
        const kept = results.length - archived;
        console.log(`[winnow] ${new Date().toLocaleTimeString()} — ${results.length} new: ${archived} archived, ${kept} kept`);
      }
    } catch (err) {
      console.error(`[winnow] Scan error (${account}): ${err.message}`);
    }
  }
}
