import { listEmailItems } from './store.js';

const EMAIL_PATTERN = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function matchScore(query, name, email) {
  const needle = normalized(query);
  const normalizedName = normalized(name);
  const normalizedEmail = normalized(email);
  if (!needle) return 0;
  if (normalizedEmail === needle || normalizedName === needle) return 100;
  if (normalizedName.startsWith(`${needle} `) || normalizedEmail.startsWith(needle)) return 85;
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length && tokens.every(token => normalizedName.includes(token) || normalizedEmail.includes(token))) return 70;
  if (normalizedName.includes(needle) || normalizedEmail.includes(needle)) return 50;
  return 0;
}

export function resolveTrackedContacts(query, { limit = 5 } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const candidates = new Map();
  const items = listEmailItems({ state: 'all', limit: 200 }).items;

  for (const item of items) {
    const email = String(item.fromEmail || '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) continue;
    const name = String(item.fromName || '').trim() || email;
    const score = matchScore(query, name, email);
    if (!score) continue;
    const existing = candidates.get(email);
    const seenAt = item.processedAt || item.createdAt || '';
    if (!existing) {
      candidates.set(email, {
        name,
        email,
        score,
        messageCount: 1,
        lastSeenAt: seenAt,
        accounts: [item.account].filter(Boolean),
        source: 'winnow_history',
      });
      continue;
    }
    existing.score = Math.max(existing.score, score);
    existing.messageCount += 1;
    if (seenAt > existing.lastSeenAt) {
      existing.lastSeenAt = seenAt;
      existing.name = name;
    }
    if (item.account && !existing.accounts.includes(item.account)) existing.accounts.push(item.account);
  }

  return [...candidates.values()]
    .sort((left, right) => (
      right.score - left.score
      || right.messageCount - left.messageCount
      || right.lastSeenAt.localeCompare(left.lastSeenAt)
      || left.email.localeCompare(right.email)
    ))
    .slice(0, boundedLimit);
}
