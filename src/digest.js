import { getResultsSinceLastDigest, markDigestSent } from './state.js';
import { postToSlack } from './notify.js';

function cleanSender(from) {
  if (!from) return 'Unknown';
  const match = from.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  const emailMatch = from.match(/([^@]+)@/);
  if (emailMatch) return emailMatch[1];
  return from.slice(0, 30);
}

function gmailLink(threadId) {
  if (!threadId) return null;
  return `https://mail.google.com/mail/u/0/#all/${threadId}`;
}

function formatResultCompact(r) {
  const sender = cleanSender(r.from);
  const link = gmailLink(r.threadId);
  if (link) {
    return `  • <${link}|${r.subject}> — _${sender}_`;
  }
  return `  • ${r.subject} — _${sender}_`;
}

export function formatDigest(results, account) {
  // Only include archived emails in the report
  const archived = results.filter(r => r.archive || r.priority === 'low');

  if (archived.length === 0) {
    return `📬 *Winnow Archive Report* — Nothing was auto-archived since last report.`;
  }

  const now = new Date().toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  });

  const totalScanned = results.length;
  const sections = [];

  // Header
  sections.push(`📬 *Winnow Archive Report*`);
  sections.push(`${now} · ${totalScanned} emails scanned · ${archived.length} auto-archived`);
  sections.push('');
  sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  sections.push(`🗂️ *Auto-Archived* (${archived.length})`);
  sections.push('');

  for (const r of archived) {
    sections.push(formatResultCompact(r));
  }

  sections.push('');
  sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  sections.push(`💡 _Reply to adjust: "keep emails from [sender]" or "stop archiving [type]"_`);

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
    console.log(`[winnow] Archive report posted to Slack (${results.length} emails)`);
  } else {
    console.log(text);
  }

  return text;
}
