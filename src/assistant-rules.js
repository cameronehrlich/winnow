const RULE_EFFECTS = new Set(['archive', 'keep']);
const MATCHER_KINDS = new Set(['sender', 'domain', 'list_id']);
const FORBIDDEN_FIELDS = new Set([
  'action',
  'always',
  'trigger',
  'command',
  'script',
  'shell',
  'suppress_feed',
  'suppressFeed',
].map(field => field.toLowerCase()));

function requiredString(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new RangeError(`${name} exceeds ${maxLength} characters`);
  if (/\0|[\r\n]/.test(normalized)) throw new TypeError(`${name} must not contain control characters`);
  return normalized;
}

function normalizedKind(value) {
  const kind = String(value || '').trim().toLowerCase().replace('-', '_');
  if (!MATCHER_KINDS.has(kind)) throw new TypeError('matcherKind must be sender, domain, or list_id');
  return kind;
}

function normalizeEmailAddress(value) {
  const input = String(value || '').trim();
  const angleMatch = input.match(/<([^<>]+@[^<>]+)>/);
  const candidate = (angleMatch?.[1] || input).trim().toLowerCase();
  return /^[^\s@,<>]+@[^\s@,<>]+$/.test(candidate) ? candidate : '';
}

function normalizeDomain(value) {
  const candidate = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^\.+|\.+$/g, '');
  if (!candidate || candidate.length > 253 || !candidate.includes('.')) return '';
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(candidate)) return '';
  if (candidate.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return '';
  return candidate;
}

function normalizeListId(value) {
  const input = String(value || '').trim();
  const candidate = (input.match(/<([^<>]+)>/)?.[1] || input)
    .trim()
    .toLowerCase();
  return candidate && candidate.length <= 512 && !/[\r\n\0\s]/.test(candidate) ? candidate : '';
}

function headersFrom(message) {
  const candidates = [
    message?.headers,
    message?.payload?.headers,
    message?.message?.headers,
    message?.message?.payload?.headers,
  ];
  for (const headers of candidates) {
    if (Array.isArray(headers)) {
      return Object.fromEntries(headers
        .filter(header => typeof header?.name === 'string')
        .map(header => [header.name.toLowerCase(), String(header.value || '')]));
    }
    if (headers && typeof headers === 'object') {
      return Object.fromEntries(Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), String(value || '')]));
    }
  }
  return {};
}

/**
 * Validate and normalize a deterministic assistant-created rule. These rules
 * intentionally cannot contain executable hooks or the free-form YAML rule
 * fields used by Winnow's legacy operator-managed configuration.
 */
export function validateAssistantRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new TypeError('rule must be an object');
  }
  for (const field of Object.keys(rule)) {
    if (FORBIDDEN_FIELDS.has(field.toLowerCase())) {
      throw new TypeError(`assistant rules cannot contain ${field}`);
    }
  }

  const effect = String(rule.effect || '').trim().toLowerCase();
  if (!RULE_EFFECTS.has(effect)) throw new TypeError('effect must be archive or keep');
  const matcherKind = normalizedKind(rule.matcherKind ?? rule.matcher_kind);
  const rawMatcherValue = requiredString(rule.matcherValue ?? rule.matcher_value, 'matcherValue', 512);
  const matcherValue = matcherKind === 'sender'
    ? normalizeEmailAddress(rawMatcherValue)
    : (matcherKind === 'domain' ? normalizeDomain(rawMatcherValue) : normalizeListId(rawMatcherValue));
  if (!matcherValue) throw new TypeError(`matcherValue is not a valid ${matcherKind} value`);

  const account = requiredString(rule.account, 'account', 320).toLowerCase();
  if (!normalizeEmailAddress(account)) throw new TypeError('account is invalid');

  return {
    ...(rule.id == null ? {} : { id: requiredString(rule.id, 'id', 128) }),
    account,
    effect,
    matcherKind,
    matcherValue,
    ...(typeof rule.description === 'string' ? { description: rule.description.slice(0, 1000) } : {}),
    enabled: rule.enabled !== false,
    ...(rule.sourceEmailItemId || rule.source_email_item_id
      ? { sourceEmailItemId: requiredString(rule.sourceEmailItemId || rule.source_email_item_id, 'sourceEmailItemId', 300) }
      : {}),
    ...(typeof rule.createdBy === 'string' || typeof rule.created_by === 'string'
      ? { createdBy: String(rule.createdBy || rule.created_by).slice(0, 100) }
      : {}),
    ...(typeof rule.createdAt === 'string' || typeof rule.created_at === 'string'
      ? { createdAt: String(rule.createdAt || rule.created_at).slice(0, 100) }
      : {}),
    ...(typeof rule.updatedAt === 'string' || typeof rule.updated_at === 'string'
      ? { updatedAt: String(rule.updatedAt || rule.updated_at).slice(0, 100) }
      : {}),
  };
}

export function matchAssistantRule(rule, message) {
  const normalized = validateAssistantRule(rule);
  if (!normalized.enabled) return false;
  if (message?.account && String(message.account).toLowerCase() !== normalized.account) return false;

  const headers = headersFrom(message || {});
  const sender = normalizeEmailAddress(headers.from || message?.from || message?.From || '');
  if (normalized.matcherKind === 'sender') return sender === normalized.matcherValue;
  if (normalized.matcherKind === 'domain') {
    return sender.includes('@') && sender.slice(sender.lastIndexOf('@') + 1) === normalized.matcherValue;
  }
  const listId = normalizeListId(headers['list-id'] || message?.listId || message?.list_id || '');
  return listId === normalized.matcherValue;
}

/**
 * Return the first matching rule. Callers retain explicit ordering control so
 * policy does not silently change when new match kinds are introduced.
 */
export function findMatchingAssistantRule(rules, message) {
  if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
  return rules.find(rule => matchAssistantRule(rule, message)) || null;
}
