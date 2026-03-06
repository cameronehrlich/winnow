import { getResultsSinceLastDigest, markDigestSent } from './state.js';
import { postToSlack } from './notify.js';

function groupByPriority(results) {
  const groups = { urgent: [], normal: [], low: [] };
  for (const r of results) {
    groups[r.priority]?.push(r);
  }
  return groups;
}

function cleanSender(from) {
  // Extract just the name, strip email address
  if (!from) return 'Unknown';
  const match = from.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  // If it's just an email, use the part before @
  const emailMatch = from.match(/([^@]+)@/);
  if (emailMatch) return emailMatch[1];
  return from.slice(0, 30);
}

function formatResultDetailed(r) {
  const sender = cleanSender(r.from);
  const lines = [];
  lines.push(`  *${sender}*`);
  lines.push(`  ${r.subject}`);
  if (r.summary && r.summary !== r.subject) {
    lines.push(`  _${r.summary}_`);
  }
  if (r.bumped) {
    lines.push(`  ⚠️ _${r.confidence}% confidence (bumped from ${r.originalPriority})_`);
  }
  if (r.unsubscribeLink) {
    lines.push(`  📎 <${r.unsubscribeLink}|Unsubscribe>`);
  }
  return lines.join('\n');
}

function formatResultCompact(r) {
  const sender = cleanSender(r.from);
  return `  • *${sender}* — ${r.subject}`;
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
    timeZone: 'America/Los_Angeles',
  });

  const lowPct = results.length > 0
    ? Math.round((groups.low.length / results.length) * 100)
    : 0;

  const sections = [];

  // Header
  sections.push(`📬 *Winnow Daily Digest*`);
  sections.push(`${now} · ${results.length} emails · ${lowPct}% auto-archived`);
  sections.push('');

  // Urgent — detailed format, each email clearly separated
  if (groups.urgent.length > 0) {
    sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    sections.push(`🔴 *URGENT* (${groups.urgent.length}) — _already alerted_`);
    sections.push('');
    for (const r of groups.urgent.slice(0, 10)) {
      sections.push(formatResultDetailed(r));
      sections.push('');
    }
    if (groups.urgent.length > 10) {
      sections.push(`  _+${groups.urgent.length - 10} more_`);
      sections.push('');
    }
  }

  // Normal — detailed format
  if (groups.normal.length > 0) {
    sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    sections.push(`🟡 *WORTH REVIEWING* (${groups.normal.length})`);
    sections.push('');
    for (const r of groups.normal.slice(0, 8)) {
      sections.push(formatResultDetailed(r));
      sections.push('');
    }
    if (groups.normal.length > 8) {
      sections.push(`  _+${groups.normal.length - 8} more_`);
      sections.push('');
    }
  }

  // Low — compact format (these were already handled, just a recap)
  if (groups.low.length > 0) {
    sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    sections.push(`🟢 *ARCHIVED* (${groups.low.length})`);
    sections.push('');
    for (const r of groups.low.slice(0, 10)) {
      sections.push(formatResultCompact(r));
    }
    if (groups.low.length > 10) {
      sections.push(`  _+${groups.low.length - 10} more archived_`);
    }
    sections.push('');
  }

  // Footer
  sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  sections.push(`💡 _Reply to adjust: "make [sender] low/normal/urgent"_`);

  return sections.join('\n');
}

export async function generateAndPostDigest(opts = {}) {
  const results = getResultsSinceLastDigest();
  const account = opts.account || 'all accounts';
  const text = formatDigest(results, account);

  if (opts.preview) {
    return text;
  }

  const posted = await postToSlack(text);
  if (posted) {
    markDigestSent();
    console.log(`[winnow] Digest posted to Slack (${results.length} emails)`);
  } else {
    console.log(text);
  }

  return text;
}
