import { ensureStore, listCorrespondentMessages } from './store.js';
import { getActiveAccounts } from './config.js';
import { normalizeMailRecipients } from './assistant-drafts.js';

const HISTORY_CACHE_MS = 30_000;
const historyCache = new Map();

function headerContacts(header) {
  const parts = [];
  let current = '', quoted = false, escaped = false, depth = 0;
  for (const character of String(header || '')) {
    if (escaped) { current += character; escaped = false; continue; }
    if (quoted && character === '\\') { current += character; escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    if (!quoted) {
      if (character === '<') depth++;
      if (character === '>') depth = Math.max(0, depth - 1);
      if ((character === ',' || character === ';') && depth === 0) {
        parts.push(current); current = ''; continue;
      }
    }
    current += character;
  }
  parts.push(current);
  return parts.flatMap(part => {
    const value = part.replace(/\r?\n[ \t]+/g, ' ').trim();
    try {
      const [email] = normalizeMailRecipients([value], 'contact');
      const opening = value.lastIndexOf('<');
      const name = opening >= 0 ? value.slice(0, opening).trim().replace(/^"|"$/g, '').replace(/\\(["\\])/g, '$1') : '';
      return [{ name: name || email, email }];
    } catch { return []; }
  });
}

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function matchScore(needle, normalizedName, normalizedEmail) {
  if (!needle) return 0;
  if (normalizedEmail === needle || normalizedName === needle) return 100;
  if (normalizedName.startsWith(`${needle} `) || normalizedEmail.startsWith(needle)) return 85;
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length && tokens.every(token => normalizedName.includes(token) || normalizedEmail.includes(token))) return 70;
  if (normalizedName.includes(needle) || normalizedEmail.includes(needle)) return 50;
  return 0;
}

function correspondentHistory(accounts) {
  const key = JSON.stringify([ensureStore().path, accounts]);
  const cached = historyCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.contacts;
  const candidates = new Map();
  const messages = listCorrespondentMessages({ accounts });
  const seen = new Set();

  for (const message of messages) {
    const contacts = [
      ...headerContacts(message.fromHeader),
      ...headerContacts(message.toHeader),
      ...headerContacts(message.ccHeader),
      ...headerContacts(message.bccHeader),
      ...(message.fromEmail ? headerContacts(message.fromEmail).map(contact => ({
        ...contact, name: message.fromName || contact.email,
      })) : []),
    ];
    for (const { name, email } of contacts) {
      const identity = `${message.account}\0${message.messageId}\0${email}`;
      const existing = candidates.get(email);
      const seenAt = message.timestamp || '';
      if (!existing) {
        candidates.set(email, {
          name, email, messageCount: 1, lastSeenAt: seenAt,
          accounts: [message.account], source: 'winnow_history',
          normalizedEmail: normalized(email), names: new Set([normalized(name)]),
        });
      } else {
        if (existing.names.size < 10) existing.names.add(normalized(name));
        if (!seen.has(identity)) existing.messageCount += 1;
        if (seenAt > existing.lastSeenAt) existing.lastSeenAt = seenAt;
        if (existing.name === email && name !== email) existing.name = name;
        if (!existing.accounts.includes(message.account)) existing.accounts.push(message.account);
      }
      seen.add(identity);
    }
  }
  const contacts = [...candidates.values()];
  // Only five useful scopes normally exist: each mailbox plus all mailboxes.
  // Bound retained history and include both DB and account identity in the key.
  if (historyCache.size >= 8) historyCache.clear();
  historyCache.set(key, { contacts, expiresAt: Date.now() + HISTORY_CACHE_MS });
  return contacts;
}

export function resolveTrackedContacts(query, { account = '', limit = 5 } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const accounts = getActiveAccounts().map(item => item.email)
    .filter(email => !account || email.toLowerCase() === account.toLowerCase());
  if (!accounts.length) return [];
  const needle = normalized(query);
  if (!needle) return [];
  return correspondentHistory(accounts)
    .map(({ normalizedEmail, names, ...contact }) => ({
      ...contact, score: Math.max(...[...names].map(name => matchScore(needle, name, normalizedEmail))),
    }))
    .filter(contact => contact.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || right.messageCount - left.messageCount
      || right.lastSeenAt.localeCompare(left.lastSeenAt)
      || left.email.localeCompare(right.email)
    ))
    .slice(0, boundedLimit);
}
