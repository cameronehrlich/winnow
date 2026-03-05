import { getResultsSinceLastDigest, markDigestSent } from './state.js';
import { postToSlack } from './notify.js';

function groupByPriority(results) {
  const groups = { urgent: [], normal: [], low: [] };
  for (const r of results) {
    groups[r.priority]?.push(r);
  }
  return groups;
}

function formatResult(r) {
  const parts = [`• ${r.from} — "${r.subject}" — ${r.summary}`];
  if (r.bumped) {
    parts.push(`  ⚠️ ${r.confidence}% confidence (bumped from ${r.originalPriority})`);
  }
  return parts.join('\n');
}

function truncateList(items, maxShow = 5) {
  if (items.length <= maxShow) return items.map(formatResult).join('\n');
  const shown = items.slice(0, maxShow).map(formatResult).join('\n');
  return `${shown}\n  [${items.length - maxShow} more →]`;
}

export function formatDigest(results, account) {
  if (results.length === 0) {
    return `📬 *Winnow Digest* — No new emails since last digest.`;
  }

  const groups = groupByPriority(results);
  const now = new Date().toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const sections = [];

  sections.push(`📬 *Winnow Digest* — ${now}`);
  if (account) sections.push(`Account: ${account}`);
  sections.push(`Processed: ${results.length} emails since last digest`);
  sections.push('');

  if (groups.urgent.length > 0) {
    sections.push(`🔴 *URGENT (${groups.urgent.length})* — already alerted`);
    sections.push(truncateList(groups.urgent, 10));
    sections.push('');
  }

  if (groups.normal.length > 0) {
    sections.push(`🟡 *WORTH REVIEWING (${groups.normal.length})*`);
    sections.push(truncateList(groups.normal, 8));
    sections.push('');
  }

  if (groups.low.length > 0) {
    sections.push(`🟢 *ARCHIVED (${groups.low.length})*`);
    sections.push(truncateList(groups.low, 5));
    sections.push('');
  }

  // Unsubscribe links
  const withUnsub = results.filter(r => r.unsubscribeLink);
  if (withUnsub.length > 0) {
    sections.push('📎 *Unsubscribe links found:*');
    for (const r of withUnsub.slice(0, 5)) {
      sections.push(`  • ${r.from} — ${r.unsubscribeLink}`);
    }
    sections.push('');
  }

  sections.push('💡 Reply here to train me:');
  sections.push('  "Make [sender] always low/normal/urgent"');

  return sections.join('\n');
}

export async function generateAndPostDigest(opts = {}) {
  const results = getResultsSinceLastDigest();
  const account = opts.account || 'all accounts';
  const text = formatDigest(results, account);

  if (opts.preview) {
    console.log(text);
    return text;
  }

  const posted = await postToSlack(text);
  if (posted) {
    markDigestSent();
    console.log(`[winnow] Digest posted to Slack (${results.length} emails)`);
  } else {
    // Still print it to console if Slack fails
    console.log(text);
  }

  return text;
}
