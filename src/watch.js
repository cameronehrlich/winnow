import { scan } from './scan.js';
import { getAccounts } from './config.js';

const DEFAULT_INTERVAL_SEC = 30;

export async function watch(opts = {}) {
  const accounts = getAccounts();
  const intervalSec = opts.interval || DEFAULT_INTERVAL_SEC;

  if (accounts.length === 0) {
    console.error('[winnow] No accounts configured');
    process.exit(1);
  }

  const emails = accounts.map(a => a.email);
  console.log(`[winnow] 👁️  Watch mode started — polling every ${intervalSec}s`);
  console.log(`[winnow] Accounts: ${emails.join(', ')}`);

  // Run initial scan immediately
  await runCycle(emails);

  // Then poll on interval
  const timer = setInterval(() => runCycle(emails), intervalSec * 1000);

  // Graceful shutdown
  const shutdown = (sig) => {
    console.log(`\n[winnow] ${sig} received — stopping watch`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runCycle(accounts) {
  for (const account of accounts) {
    try {
      const results = await scan(account, {
        searchQuery: 'in:inbox is:unread newer_than:1h',
      });
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
