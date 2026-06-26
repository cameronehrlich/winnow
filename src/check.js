import { GogAdapter } from './adapters/gog.js';
import { loadConfig, getAdapter } from './config.js';
import { loadState } from './state.js';

const GmailAdapters = { gog: GogAdapter };
const ARCHIVED_LABEL = 'winnow/archived';

function createAdapter() {
  const name = getAdapter();
  return new GmailAdapters[name]();
}

export async function runCheck(account) {
  const adapter = createAdapter();
  const issues = [];
  const warnings = [];
  const ok = [];

  console.log(`\n🔍 Winnow Health Check — ${account}\n`);

  // 1. Unprocessed emails: in inbox, no archived label, from recent days
  // These are emails winnow should have seen but didn't
  console.log('  Checking for unprocessed inbox emails...');
  const unprocessed = await adapter.fetchUnread(
    account,
    `in:inbox -label:${ARCHIVED_LABEL} newer_than:2d`,
    50
  );
  if (unprocessed.length > 0) {
    // Filter out messages already known in state. Kept-in-inbox emails may not
    // have Gmail labels by design, so processedIds is the source of truth here.
    const state = loadState();
    const trulyUnprocessed = unprocessed.filter(m => !state.processedIds?.includes(m.id));

    // Filter out very recent ones (< 10 min old) since they may not have been scanned yet
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const stale = trulyUnprocessed.filter(m => {
      const msgDate = m.date ? new Date(m.date).getTime() : Date.now();
      return msgDate < tenMinAgo;
    });
    if (stale.length > 0) {
      warnings.push({
        type: 'unprocessed',
        message: `${stale.length} email(s) in inbox not seen in state (older than 10 min)`,
        emails: stale.map(m => ({ subject: m.subject, from: m.from, date: m.date })),
      });
    } else {
      ok.push('All recent inbox emails have been processed');
    }
  } else {
    ok.push('No recent unprocessed inbox emails found ✓');
  }

  // 2. Failed archives: labeled archived but still in inbox
  // These mean the archive (remove INBOX) failed
  console.log('  Checking for failed archives...');
  const failedArchives = await adapter.fetchUnread(
    account,
    `in:inbox label:${ARCHIVED_LABEL} newer_than:2d`,
    50
  );
  if (failedArchives.length > 0) {
    issues.push({
      type: 'failed_archive',
      message: `${failedArchives.length} email(s) labeled ${ARCHIVED_LABEL} but still in inbox`,
      emails: failedArchives.map(m => ({ subject: m.subject, from: m.from, threadId: m.threadId })),
      autoFix: true,
    });
  } else {
    ok.push('All low-priority emails properly archived ✓');
  }

  // 3. State health: check processedIds isn't empty or corrupted
  console.log('  Checking state file health...');
  const state = loadState();
  if (!state.processedIds || state.processedIds.length === 0) {
    warnings.push({
      type: 'empty_state',
      message: 'No processed IDs in state — state may have been reset',
    });
  } else {
    ok.push(`State tracking ${state.processedIds.length} processed emails ✓`);
  }

  // 4. Scan recency: has a scan run recently?
  if (state.lastScanTime) {
    const lastScan = new Date(state.lastScanTime);
    const minSinceLastScan = (Date.now() - lastScan.getTime()) / 60000;
    if (minSinceLastScan > 15) {
      warnings.push({
        type: 'stale_scan',
        message: `Last scan was ${Math.round(minSinceLastScan)} min ago (expected every 5 min)`,
      });
    } else {
      ok.push(`Last scan ${Math.round(minSinceLastScan)} min ago ✓`);
    }
  } else {
    issues.push({ type: 'no_scans', message: 'No scans have ever run' });
  }

  // 5. Labels exist
  console.log('  Checking Gmail labels...');
  try {
    await adapter.fetchUnread(account, `label:${ARCHIVED_LABEL}`, 1);
    ok.push('Gmail labels accessible ✓');
  } catch (e) {
    issues.push({ type: 'labels', message: `Cannot access winnow labels: ${e.message}` });
  }

  // Print results
  console.log('');
  if (ok.length > 0) {
    console.log('  ✅ Passing:');
    for (const msg of ok) console.log(`     ${msg}`);
  }
  if (warnings.length > 0) {
    console.log('\n  ⚠️  Warnings:');
    for (const w of warnings) {
      console.log(`     ${w.message}`);
      if (w.emails) {
        for (const e of w.emails.slice(0, 3)) {
          console.log(`       • ${e.from} — "${e.subject}"`);
        }
        if (w.emails.length > 3) console.log(`       [${w.emails.length - 3} more]`);
      }
    }
  }
  if (issues.length > 0) {
    console.log('\n  🔴 Issues:');
    for (const i of issues) {
      console.log(`     ${i.message}`);
      if (i.emails) {
        for (const e of i.emails.slice(0, 3)) {
          console.log(`       • ${e.from} — "${e.subject}"`);
        }
      }
      if (i.autoFix) console.log(`     → Run "winnow check --fix" to auto-repair`);
    }
  }

  const healthy = issues.length === 0 && warnings.length === 0;
  if (healthy) {
    console.log('\n  🎉 All checks passed — winnow is healthy');
  }

  return { ok, warnings, issues, healthy };
}

export async function autoFix(account) {
  const adapter = createAdapter();
  let fixed = 0;

  // Fix failed archives: re-apply archive to archived-labeled emails still in inbox
  const failedArchives = await adapter.fetchUnread(
    account,
    `in:inbox label:${ARCHIVED_LABEL} newer_than:7d`,
    50
  );
  for (const msg of failedArchives) {
    console.log(`  Fixing: archiving "${msg.subject}"`);
    await adapter.modifyLabels(account, msg.threadId, {
      remove: ['INBOX', 'UNREAD'],
    });
    fixed++;
  }

  if (fixed > 0) {
    console.log(`\n  🔧 Fixed ${fixed} issue(s)`);
  } else {
    console.log('\n  ✅ Nothing to fix');
  }

  return fixed;
}
