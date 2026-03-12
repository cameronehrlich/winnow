import { Command } from 'commander';
import { scan } from './scan.js';
import { watch } from './watch.js';
import { generateAndPostDigest } from './digest.js';
import { loadConfig, setConfigField, getAccountEmails } from './config.js';
import { addRule, removeRule, listRules } from './rules.js';
import { getStats } from './state.js';
import { muteAlerts, unmuteAlerts, getAlertStatus } from './notify.js';
import { runCheck, autoFix } from './check.js';

const program = new Command();

program
  .name('winnow')
  .description('AI email triage — separate the grain from the chaff')
  .version('1.0.0');

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
  .description('Scan all accounts + generate digest (everything since last run)')
  .option('--dry-run', 'Classify but don\'t take any Gmail actions')
  .action(async (opts) => {
    try {
      const config = loadConfig();
      for (const account of getAccountEmails()) {
        console.log(`\n📬 Scanning ${account}...`);
        const results = await scan(account, { dryRun: opts.dryRun });
        console.log(`✅ Processed ${results.length} emails`);
      }
      console.log('\n📋 Generating digest...');
      const digest = await generateAndPostDigest({ preview: false });
      console.log('✅ Digest posted to Slack');
    } catch (err) {
      console.error('❌ Run failed:', err.message);
      process.exit(1);
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
