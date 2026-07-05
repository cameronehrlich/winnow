import { Command } from 'commander';
import { scan } from './scan.js';
import { watch } from './watch.js';
import { generateAndPostDigest } from './digest.js';
import { loadConfig, setConfigField, getAccountEmails, getAdapter } from './config.js';
import { addRule, removeRule, listRules } from './rules.js';
import { getStats, recordUnsubscribe, getUnsubscribes } from './state.js';
import { muteAlerts, unmuteAlerts, getAlertStatus } from './notify.js';
import { runCheck, autoFix } from './check.js';
import { archiveEmail, moveEmailToInbox } from './actions.js';
import { startDaemon } from './daemon.js';
import { getDailyActionSummary } from './store.js';
import { runDoctor } from './doctor.js';

const program = new Command();

program
  .name('winnow')
  .description('AI email triage — separate the grain from the chaff')
  .version('1.0.0');

program
  .command('archive <threadId>')
  .description('Archive a specific email thread by Gmail thread ID')
  .requiredOption('-a, --account <email>', 'Gmail account the thread belongs to')
  .action(async (threadId, opts) => {
    try {
      await archiveEmail({ account: opts.account, threadId, source: 'cli', reason: 'CLI archive command' });
      console.log(`✅ Archived thread ${threadId} for ${opts.account}`);
    } catch (err) {
      console.error('❌ Archive failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('unarchive <threadId>')
  .description('Move a thread back to inbox')
  .requiredOption('-a, --account <email>', 'Gmail account the thread belongs to')
  .action(async (threadId, opts) => {
    try {
      await moveEmailToInbox({ account: opts.account, threadId, source: 'cli', reason: 'CLI unarchive command' });
      console.log(`✅ Moved thread ${threadId} back to inbox for ${opts.account}`);
    } catch (err) {
      console.error('❌ Unarchive failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('scan')
  .description('Scan and triage new unread emails')
  .option('-a, --account <email>', 'Specific account to scan')
  .option('--dry-run', 'Classify but don\'t take any Gmail actions')
  .option('--inbox', 'Process entire inbox (not just new unread)')
  .option('--since <duration>', 'Process emails from last duration (e.g., 7d, 24h)')
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const accounts = opts.account ? [opts.account] : getAccountEmails();
      for (const account of accounts) {
        console.log(`\n📬 Scanning ${account}...`);
        const scanOpts = { dryRun: opts.dryRun };
        if (opts.inbox) scanOpts.searchQuery = 'in:inbox';
        else if (opts.since) scanOpts.searchQuery = `in:inbox newer_than:${opts.since}`;
        const results = await scan(account, scanOpts);
        console.log(`✅ Processed ${results.length} emails`);
        const archived = results.filter(r => r.archive).length;
        const kept = results.length - archived;
        console.log(`   🗂️ ${archived} archived  📥 ${kept} kept in inbox`);
      }
    } catch (err) {
      console.error('❌ Scan failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('rescan')
  .description('Re-classify all processed emails with current rules and correct labels')
  .option('-a, --account <email>', 'Specific account to rescan')
  .option('--since <duration>', 'Re-scan emails from last duration (e.g., 7d, 24h)', '7d')
  .option('--dry-run', 'Show new classifications without applying changes')
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const accounts = opts.account ? [opts.account] : getAccountEmails();
      for (const account of accounts) {
        console.log(`\n🔄 Rescanning ${account} (since ${opts.since})...`);
        const searchQuery = `newer_than:${opts.since}`;
        const results = await scan(account, {
          dryRun: opts.dryRun,
          searchQuery,
          skipProcessedCheck: true,
          runHooks: false,
          postToFeed: false,
          sendPush: false,
          recordProcessing: false,
        });
        console.log(`✅ Re-classified ${results.length} emails`);
        const archived = results.filter(r => r.archive).length;
        const kept = results.length - archived;
        console.log(`   🗂️ ${archived} archived  📥 ${kept} kept in inbox`);
      }
    } catch (err) {
      console.error('❌ Rescan failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('digest')
  .description('Generate and post daily digest')
  .option('--preview', 'Preview digest without posting to Slack')
  .action(async (opts) => {
    try {
      const digest = await generateAndPostDigest({ preview: opts.preview });
      if (opts.preview) {
        console.log('\n📋 Digest Preview:\n');
        console.log(digest);
      } else {
        console.log('✅ Digest posted to Slack');
      }
    } catch (err) {
      console.error('❌ Digest failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('run')
  .description('Scan all accounts and print today\'s structured summary')
  .option('--dry-run', 'Classify but don\'t take any Gmail actions')
  .action(async (opts) => {
    try {
      const config = loadConfig();
      for (const account of getAccountEmails()) {
        console.log(`\n📬 Scanning ${account}...`);
        const results = await scan(account, { dryRun: opts.dryRun });
        console.log(`✅ Processed ${results.length} emails`);
      }
      console.log('\n📋 Today\'s Summary:');
      printSummary(getDailyActionSummary({}));
    } catch (err) {
      console.error('❌ Run failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('daemon')
  .description('Run scanner, Slack actions, local API, and mailbox reconciliation')
  .option('-i, --interval <seconds>', 'Scan interval in seconds', '30')
  .action(async (opts) => {
    try {
      await startDaemon({ interval: parseInt(opts.interval, 10) });
    } catch (err) {
      console.error('❌ Daemon failed:', err.message);
      process.exit(1);
    }
  });

function todayLocalDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function printSummary(summary) {
  const c = summary.counters;
  console.log(`  Date: ${summary.date} (${summary.timeZone})`);
  console.log(`  Processed: ${c.processed}`);
  console.log(`  Kept: ${c.kept}`);
  console.log(`  Auto-archived: ${c.autoArchived}`);
  console.log(`  Manually archived: ${c.manualArchived}`);
  console.log(`  Restored to inbox: ${c.restoredToInbox}`);
  console.log(`  Unsubscribed: ${c.unsubscribedSucceeded} succeeded, ${c.unsubscribedFailed} failed, ${c.unsubscribedAttempted} attempted`);
  console.log(`  Ephemeral: ${c.ephemeral}`);
  console.log(`  Low-confidence kept: ${c.lowConfidenceKept}`);
  if (summary.lists.actedOn.length) {
    console.log('\n  Recent actions:');
    for (const item of summary.lists.actedOn.slice(-10).reverse()) {
      console.log(`    ${item.timestamp}  ${item.actionType}  ${item.subject || '(no subject)'}`);
    }
  }
}

program
  .command('summary')
  .description('Show structured daily action summary')
  .option('--today', 'Use today in America/Los_Angeles')
  .option('--date <YYYY-MM-DD>', 'Summary date in America/Los_Angeles')
  .option('-a, --account <email>', 'Specific account')
  .option('--json', 'Output JSON')
  .action((opts) => {
    const summary = getDailyActionSummary({
      date: opts.date || (opts.today ? todayLocalDate() : undefined),
      account: opts.account || '',
    });
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printSummary(summary);
    }
  });

program
  .command('watch')
  .description('Watch inbox in real-time — poll every N seconds and triage immediately')
  .option('-i, --interval <seconds>', 'Poll interval in seconds', '30')
  .action(async (opts) => {
    try {
      await watch({ interval: parseInt(opts.interval) });
    } catch (err) {
      console.error('❌ Watch failed:', err.message);
      process.exit(1);
    }
  });

const rule = program
  .command('rule')
  .description('Manage custom rules');

rule
  .command('add <description>')
  .description('Add a custom rule (plain English)')
  .requiredOption('-a, --account <email>', 'Account to add the rule to')
  .option('--archive', 'Auto-archive matching emails (default)')
  .option('--keep', 'Keep matching emails in inbox')
  .action(async (description, opts) => {
    try {
      const archive = opts.keep ? false : true;
      const id = await addRule(description, archive, opts.account);
      console.log(`✅ Rule added to ${opts.account}: ${id} → ${archive ? 'archive' : 'keep in inbox'}`);
    } catch (err) {
      console.error('❌ Failed to add rule:', err.message);
      process.exit(1);
    }
  });

rule
  .command('remove <id>')
  .description('Remove a custom rule by ID')
  .requiredOption('-a, --account <email>', 'Account to remove the rule from')
  .action(async (id, opts) => {
    try {
      await removeRule(id, opts.account);
      console.log(`✅ Rule removed from ${opts.account}: ${id}`);
    } catch (err) {
      console.error('❌ Failed to remove rule:', err.message);
      process.exit(1);
    }
  });

program
  .command('rules')
  .description('List all active rules')
  .option('-a, --account <email>', 'Show rules for a specific account (omit for all accounts)')
  .action(async (opts) => {
    try {
      const accounts = opts.account ? [opts.account] : getAccountEmails();
      for (const account of accounts) {
        const rules = await listRules(account);
        console.log(`\n📋 Rules for ${account}:\n`);
        for (const rule of rules) {
          const action = rule.archive === true ? '🗂️ archive' : rule.archive === false ? '📥 keep' : (rule.priority === 'low' ? '🗂️ archive' : '📥 keep');
          const source = rule.source === 'baseline' ? '(baseline)' : '(custom)';
          console.log(`  ${action} — ${rule.id} — ${rule.match} ${source}`);
        }
        console.log(`\n  Total: ${rules.length} rules`);
      }
    } catch (err) {
      console.error('❌ Failed to list rules:', err.message);
      process.exit(1);
    }
  });

program
  .command('stats')
  .description('Show processing statistics')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const stats = getStats();

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log('\n📊 Winnow Stats\n');
      console.log(`  Last scan:    ${stats.lastScanTime || 'never'}`);
      console.log(`  Last digest:  ${stats.lastDigestTime || 'never'}`);
      console.log(`  Total emails: ${stats.totalProcessed}`);

      const totalArchived = (stats.byPriority?.low || 0);
      const totalKept = stats.totalProcessed - totalArchived;
      console.log(`  Breakdown:`);
      console.log(`    🗂️ Archived:  ${totalArchived}`);
      console.log(`    📥 Kept:      ${totalKept}`);
      console.log(`    📌 Ephemeral: ${stats.ephemeralCount || 0}`);

      const unsubscribes = stats.unsubscribes || { total: 0, byStatus: {} };
      console.log(`    🚫 Unsubscribes: ${unsubscribes.total || 0} (${unsubscribes.byStatus?.succeeded || 0} succeeded)`);

      const pctArchived = stats.totalProcessed > 0
        ? Math.round((totalArchived / stats.totalProcessed) * 100)
        : 0;
      console.log(`\n  📈 Inbox reduction: ${pctArchived}% of emails auto-archived`);
      console.log(`  ⏱️  Est. time saved: ~${Math.round(totalArchived * 0.5)} min (30s per email you didn't have to read)`);

      // Daily breakdown
      const daily = stats.daily || {};
      const days = Object.keys(daily).sort().reverse().slice(0, 7);
      if (days.length > 0) {
        console.log('\n  📅 Daily Breakdown (last 7 days):');
        console.log('  Date         Emails  Archived  Kept  Scans  Archived%');
        console.log('  ' + '─'.repeat(55));
        for (const day of days) {
          const d = daily[day];
          const dayArchived = d.byPriority?.low || 0;
          const dayKept = d.processed - dayArchived;
          const pct = d.processed > 0 ? Math.round((dayArchived / d.processed) * 100) : 0;
          console.log(`  ${day}   ${String(d.processed).padStart(5)}  ${String(dayArchived).padStart(8)}  ${String(dayKept).padStart(4)}  ${String(d.scansRun || 0).padStart(5)}  ${pct}%`);
        }
      }

      // Custom rules count per account
      const allAccounts = getAccountEmails();
      for (const acct of allAccounts) {
        const rules = await listRules(acct);
        const customRules = rules.filter(r => r.source !== 'baseline');
        console.log(`\n  📋 ${acct}: ${customRules.length} custom / ${rules.length} total rules`);
      }

    } catch (err) {
      console.error('❌ Failed to get stats:', err.message);
      process.exit(1);
    }
  });


const unsubscribe = program
  .command('unsubscribe')
  .description('Manage unsubscribe log');

unsubscribe
  .command('add <sender>')
  .description('Record an unsubscribe attempt/success')
  .option('--status <status>', 'succeeded|failed|attempted', 'succeeded')
  .option('--account <email>', 'Gmail account')
  .option('--thread-id <id>', 'Gmail thread ID')
  .option('--subject <subject>', 'Email subject')
  .option('--source <source>', 'Source of log entry', 'manual')
  .option('--method <method>', 'one-click|link|form|mailto|unknown', 'unknown')
  .option('--note <note>', 'Additional note')
  .option('--timestamp <iso>', 'Timestamp for backfills')
  .option('--source-message-id <id>', 'Slack/session message ID for dedupe')
  .option('--url-host <host>', 'Unsubscribe URL host')
  .action((sender, opts) => {
    const entry = recordUnsubscribe({
      sender,
      status: opts.status,
      account: opts.account,
      threadId: opts.threadId,
      subject: opts.subject,
      source: opts.source,
      method: opts.method,
      note: opts.note,
      timestamp: opts.timestamp,
      sourceMessageId: opts.sourceMessageId,
      urlHost: opts.urlHost,
    });
    console.log(`✅ Recorded unsubscribe: ${entry.sender} (${entry.status})`);
  });

unsubscribe
  .command('list')
  .description('List recorded unsubscribes')
  .option('--json', 'Output as JSON')
  .option('--limit <n>', 'Max entries to show', '50')
  .action((opts) => {
    const data = getUnsubscribes();
    const entries = [...(data.entries || [])]
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, parseInt(opts.limit, 10));
    if (opts.json) {
      console.log(JSON.stringify({ ...data, entries }, null, 2));
      return;
    }
    console.log(`\n🚫 Unsubscribes: ${data.total || 0}`);
    console.log(`  Succeeded: ${data.byStatus?.succeeded || 0}  Failed: ${data.byStatus?.failed || 0}  Attempted: ${data.byStatus?.attempted || 0}`);
    for (const e of entries) {
      const date = (e.timestamp || '').slice(0, 10);
      const subject = e.subject ? ` — ${e.subject}` : '';
      console.log(`  ${date}  ${e.status || 'succeeded'}  ${e.sender}${subject}`);
    }
  });

program
  .command('check')
  .description('Sanity check — verify winnow is working correctly')
  .option('-a, --account <email>', 'Specific account to check')
  .option('--fix', 'Auto-fix any repairable issues')
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const accounts = opts.account ? [opts.account] : getAccountEmails();
      for (const account of accounts) {
        const result = await runCheck(account);
        if (opts.fix && result.issues.some(i => i.autoFix)) {
          console.log('\n  🔧 Running auto-fix...');
          await autoFix(account);
        }
      }
    } catch (err) {
      console.error('❌ Check failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Verify local runtime dependencies and gog adapter compatibility')
  .option('-a, --account <email>', 'Specific account to check')
  .action(async (opts) => {
    try {
      const result = await runDoctor({ account: opts.account || '' });
      if (!result.healthy) process.exit(1);
    } catch (err) {
      console.error('Doctor failed:', err.message);
      process.exit(1);
    }
  });

const alerts = program
  .command('alerts')
  .description('Manage urgent Slack alerts');

alerts
  .command('on')
  .description('Enable urgent Slack alerts')
  .action(() => {
    unmuteAlerts();
    console.log('✅ Urgent alerts enabled');
  });

alerts
  .command('off')
  .description('Disable urgent Slack alerts')
  .option('--for <duration>', 'Mute temporarily (e.g., 30m, 2h, 1d)')
  .action((opts) => {
    let minutes = null;
    if (opts.for) {
      const match = opts.for.match(/^(\d+)(m|h|d)$/);
      if (!match) {
        console.error('❌ Invalid duration. Use format like 30m, 2h, or 1d');
        process.exit(1);
      }
      const [, num, unit] = match;
      minutes = parseInt(num) * (unit === 'm' ? 1 : unit === 'h' ? 60 : 1440);
    }
    muteAlerts(minutes);
    if (minutes) {
      console.log(`🔇 Urgent alerts muted for ${opts.for}`);
    } else {
      console.log('🔇 Urgent alerts muted (permanently until you run: winnow alerts on)');
    }
  });

alerts
  .command('status')
  .description('Check alert status')
  .action(() => {
    const status = getAlertStatus();
    if (!status.muted) {
      console.log('🔔 Alerts are ON');
    } else if (status.until) {
      console.log(`🔇 Alerts muted until ${new Date(status.until).toLocaleString()}`);
    } else {
      console.log('🔇 Alerts muted permanently');
    }
  });

const feed = program
  .command('feed')
  .description('Toggle email feed — posts to Slack for every email processed');

feed
  .command('on')
  .description('Enable email feed')
  .action(() => {
    setConfigField('feed', true);
    console.log('📡 Email feed ON — every email will post to Slack');
  });

feed
  .command('off')
  .description('Disable email feed')
  .action(() => {
    setConfigField('feed', false);
    console.log('📡 Email feed OFF');
  });

feed
  .command('status')
  .description('Check email feed status')
  .action(() => {
    const config = loadConfig();
    const enabled = config.feed !== false; // on by default
    console.log(enabled ? '📡 Email feed is ON' : '📡 Email feed is OFF');
  });

program.parse();
