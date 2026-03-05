import { Command } from 'commander';
import { scan } from './scan.js';
import { generateAndPostDigest } from './digest.js';
import { loadConfig } from './config.js';
import { addRule, removeRule, listRules } from './rules.js';
import { getStats } from './state.js';
import { muteAlerts, unmuteAlerts, getAlertStatus } from './notify.js';

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
  .action(async () => {
    try {
      const stats = getStats();
      console.log('\n📊 Winnow Stats:\n');
      console.log(`  Last scan: ${stats.lastScanTime || 'never'}`);
      console.log(`  Last digest: ${stats.lastDigestTime || 'never'}`);
      console.log(`  Total processed: ${stats.totalProcessed}`);
      console.log(`  Breakdown:`);
      console.log(`    🔴 Urgent: ${stats.byPriority?.urgent || 0}`);
      console.log(`    🟡 Normal: ${stats.byPriority?.normal || 0}`);
      console.log(`    🟢 Low: ${stats.byPriority?.low || 0}`);
    } catch (err) {
      console.error('❌ Failed to get stats:', err.message);
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
