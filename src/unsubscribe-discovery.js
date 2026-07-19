const MAX_DISCOVERY_BODY_LENGTH = 100_000;
const MAX_URL_LENGTH = 4096;
const UNSUBSCRIBE_LANGUAGE = /\b(?:unsubscribe|un-subscribe|opt[ -]?out|stop (?:receiving|getting) (?:these |this )?emails?|manage (?:email )?(?:preferences|subscriptions))\b/i;
const URL_IN_TEXT_RE = /(?:https?:\/\/[^\s<>"')\]]+|mailto:[^\s<>"')\]]+)/gi;

function decodeHtmlEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function headerMap(message) {
  const candidates = [
    message?.headers,
    message?.payload?.headers,
    message?.message?.headers,
    message?.message?.payload?.headers,
  ];
  for (const headers of candidates) {
    if (Array.isArray(headers) && headers.length) {
      return Object.fromEntries(headers.slice(0, 100)
        .filter(header => typeof header?.name === 'string')
        .map(header => [header.name.toLowerCase(), String(header.value || '').slice(0, 20_000)]));
    }
    if (headers && typeof headers === 'object' && Object.keys(headers).length) {
      return Object.fromEntries(Object.entries(headers).slice(0, 100)
        .map(([name, value]) => [name.toLowerCase(), String(value || '').slice(0, 20_000)]));
    }
  }
  return {};
}

function normalizeCandidate(raw) {
  const value = decodeHtmlEntities(raw).trim().replace(/^<|>$/g, '');
  if (!value || value.length > MAX_URL_LENGTH || /[\r\n\0]/.test(value)) return null;
  try {
    const url = new URL(value);
    const type = url.protocol === 'http:' || url.protocol === 'https:'
      ? 'http'
      : (url.protocol === 'mailto:' ? 'mailto' : null);
    if (!type) return null;
    if (type === 'http' && !url.hostname) return null;
    if (type === 'mailto' && !url.pathname.includes('@')) return null;
    return { type, url: url.toString() };
  } catch {
    return null;
  }
}

function headerCandidates(value) {
  const matches = [];
  const input = String(value || '').slice(0, 20_000);
  for (const match of input.matchAll(/<((?:https?:\/\/|mailto:)[^>]+)>|((?:https?:\/\/|mailto:)[^,\s>]+)/gi)) {
    matches.push(match[1] || match[2]);
  }
  return matches;
}

function anchorCandidates(body) {
  const candidates = [];
  for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attributes = match[1] || '';
    const label = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const href = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!href) continue;
    const semanticContext = `${label} ${attributes.replace(/\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')}`;
    if (!UNSUBSCRIBE_LANGUAGE.test(semanticContext)) continue;
    candidates.push(href[1] || href[2] || href[3]);
  }
  return candidates;
}

function plainTextCandidates(body) {
  const candidates = [];
  const text = decodeHtmlEntities(body)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  for (const line of text.split(/\r?\n/)) {
    if (!UNSUBSCRIBE_LANGUAGE.test(line)) continue;
    for (const match of line.matchAll(URL_IN_TEXT_RE)) {
      candidates.push(match[0].replace(/[.,;:!?]+$/, ''));
    }
  }
  return candidates;
}

function decodePayloadBody(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 20) return '';
  const mimeType = String(payload.mimeType || '').toLowerCase();
  const encoded = payload.body?.data;
  if (typeof encoded === 'string' && encoded.length <= MAX_DISCOVERY_BODY_LENGTH * 2
    && (mimeType.startsWith('text/') || !mimeType)) {
    try {
      return Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
        .toString('utf8')
        .slice(0, MAX_DISCOVERY_BODY_LENGTH);
    } catch {
      return '';
    }
  }
  const parts = Array.isArray(payload.parts) ? payload.parts.slice(0, 100) : [];
  const preferred = [
    parts.find(part => String(part?.mimeType || '').toLowerCase() === 'text/html'),
    parts.find(part => String(part?.mimeType || '').toLowerCase() === 'text/plain'),
    ...parts,
  ];
  for (const part of preferred) {
    const body = decodePayloadBody(part, depth + 1);
    if (body) return body;
  }
  return '';
}

function messageBody(message) {
  const candidates = [
    message?.body,
    message?.Body,
    message?.text,
    message?.message?.body,
    decodePayloadBody(message?.payload),
    decodePayloadBody(message?.message?.payload),
  ];
  return candidates
    .filter(value => typeof value === 'string' && value)
    .map(value => value.slice(0, MAX_DISCOVERY_BODY_LENGTH))
    .sort((left, right) => right.length - left.length)[0] || '';
}

/**
 * Discover unsubscribe methods using only URLs present in trusted mail fields.
 * This function deliberately does no network access. Callers must route any
 * selected URL through validateUnsubscribeUrl/followUnsubscribeLink at the
 * separately confirmed execution step.
 */
export function discoverUnsubscribeMethods(message) {
  const headers = headerMap(message);
  const oneClick = /list-unsubscribe\s*=\s*one-click/i.test(headers['list-unsubscribe-post'] || '');
  const discovered = [];
  const seen = new Set();

  const add = (raw, source, isOneClick = false) => {
    const normalized = normalizeCandidate(raw);
    if (!normalized) return;
    const key = normalized.url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    discovered.push({
      ...normalized,
      source,
      oneClick: normalized.type === 'http' && Boolean(isOneClick),
    });
  };

  for (const candidate of headerCandidates(headers['list-unsubscribe'])) {
    add(candidate, 'header', oneClick);
  }
  // gog exposes a normalized unsubscribe field on some full-message shapes.
  // It is derived from the message headers, so preserve the same provenance.
  if (typeof message?.unsubscribe === 'string') add(message.unsubscribe, 'header', oneClick);
  if (typeof message?.message?.unsubscribe === 'string') add(message.message.unsubscribe, 'header', oneClick);

  const body = messageBody(message);
  for (const candidate of anchorCandidates(body)) add(candidate, 'body');
  for (const candidate of plainTextCandidates(body)) add(candidate, 'body');

  discovered.sort((left, right) => {
    // Prefer an automatable body link over a mailto-only header. Header
    // provenance remains the tie-breaker within the same method type.
    const rank = method => (method.type === 'http' ? 0 : 2) + (method.source === 'header' ? 0 : 1);
    return rank(left) - rank(right);
  });
  return { methods: discovered, preferred: discovered[0] || null };
}
