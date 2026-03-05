import { Command } from 'commander';
import { scan } from './scan.js';
import { generateAndPostDigest } from './digest.js';
import { loadConfig } from './config.js';
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
      const accounts = opts.account ? [opts.account] : config.accounts;
      for (const account of accounts) {
        console.log(`\n📬 Scanning ${account}...`);
        const scanOpts = { dryRun: opts.dryRun };
        if (opts.inbox) scanOpts.searchQuery = 'in:inbox';
        else if (opts.since) scanOpts.searchQuery = `in:inbox newer_than:${opts.since}`;
        const results = await scan(account, scanOpts);
        console.log(`✅ Processed ${results.length} emails`);
        const urgent = results.filter(r => r.priority === 'urgent').length;
        const normal = results.filter(r => r.priority === 'normal').length;
        const low = results.filter(r => r.priority === 'low').length;
        console.log(`   🔴 ${urgent} urgent  🟡 ${normal} normal  🟢 ${low} low`);
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
      const accounts = opts.account ? [opts.account] : config.accounts;
      for (const account of accounts) {
        console.log(`\n🔄 Rescanning ${account} (since ${opts.since})...`);
        const searchQuery = `newer_than:${opts.since}`;
        const results = await scan(account, {
          dryRun: opts.dryRun,
          searchQuery,
          skipProcessedCheck: true,
        });
        console.log(`✅ Re-classified ${results.length} emails`);
        const urgent = results.filter(r => r.priority === 'urgent').length;
        const normal = results.filter(r => r.priority === 'normal').length;
        const low = results.filter(r => r.priority === 'low').length;
        console.log(`   🔴 ${urgent} urgent  🟡 ${normal} normal  🟢 ${low} low`);
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
      for (const account of config.accounts) {
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

const rule = program
  .command('rule')
  .description('Manage custom rules');

rule
  .command('add <description>')
  .description('Add a custom rule (plain English)')
  .option('-p, --priority <level>', 'Priority: low, normal, or urgent', 'low')
  .action(async (description, opts) => {
    try {
      const id = await addRule(description, opts.priority);
      console.log(`✅ Rule added: ${id} → ${opts.priority}`);
    } catch (err) {
      console.error('❌ Failed to add rule:', err.message);
      process.exit(1);
    }
  });

rule
  .command('remove <id>')
  .description('Remove a custom rule by ID')
  .action(async (id) => {
    try {
      await removeRule(id);
      console.log(`✅ Rule removed: ${id}`);
    } catch (err) {
      console.error('❌ Failed to remove rule:', err.message);
      process.exit(1);
    }
  });

program
  .command('rules')
  .description('List all active rules')
  .action(async () => {
    try {
      const rules = await listRules();
      console.log('\n📋 Active Rules:\n');
      for (const rule of rules) {
        const emoji = rule.priority === 'urgent' ? '🔴' : rule.priority === 'normal' ? '🟡' : '🟢';
        const source = rule.source === 'baseline' ? '(baseline)' : '(custom)';
        console.log(`  ${emoji} ${rule.id} — ${rule.match} ${source}`);
      }
      console.log(`\n  Total: ${rules.length} rules`);
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
      console.log(`  Breakdown:`);
      console.log(`    🔴 Urgent:    ${stats.byPriority?.urgent || 0}`);
      console.log(`    🟡 Normal:    ${stats.byPriority?.normal || 0}`);
      console.log(`    🟢 Low:       ${stats.byPriority?.low || 0}`);
      console.log(`    📌 Ephemeral: ${stats.ephemeralCount || 0}`);
      console.log(`    ⚠️  Bumped:    ${stats.lowConfidenceBumps || 0}`);

      const pctArchived = stats.totalProcessed > 0
        ? Math.round(((stats.byPriority?.low || 0) / stats.totalProcessed) * 100)
        : 0;
      console.log(`\n  📈 Inbox reduction: ${pctArchived}% of emails auto-archived`);
      console.log(`  ⏱️  Est. time saved: ~${Math.round((stats.byPriority?.low || 0) * 0.5)} min (30s per email you didn't have to read)`);

      // Daily breakdown
      const daily = stats.daily || {};
      const days = Object.keys(daily).sort().reverse().slice(0, 7);
      if (days.length > 0) {
        console.log('\n  📅 Daily Breakdown (last 7 days):');
        console.log('  Date         Emails  Low  Normal  Urgent  Scans  Archived%');
        console.log('  ' + '─'.repeat(60));
        for (const day of days) {
          const d = daily[day];
          const pct = d.processed > 0 ? Math.round((d.byPriority.low / d.processed) * 100) : 0;
          console.log(`  ${day}   ${String(d.processed).padStart(5)}  ${String(d.byPriority.low).padStart(3)}  ${String(d.byPriority.normal).padStart(6)}  ${String(d.byPriority.urgent).padStart(6)}  ${String(d.scansRun || 0).padStart(5)}  ${pct}%`);
        }
      }

      // Custom rules count
      const rules = await listRules();
      const customRules = rules.filter(r => r.source !== 'baseline');
      console.log(`\n  📋 Custom rules: ${customRules.length}`);
      console.log(`  📋 Total rules:  ${rules.length}`);

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
      const accounts = opts.account ? [opts.account] : config.accounts;
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

program.parse();
