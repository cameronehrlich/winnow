// Do not mistake a plain-text email address such as <person@example.com> for
// HTML. Restrict detection to tags that commonly occur in email bodies.
const HTML_TAG_RE = /<\/?(?:html|body|div|p|br|span|table|tr|td|blockquote|a|ul|ol|li|hr)\b[^>]*>/i;

const HTML_QUOTE_MARKERS = [
  /<(?:div|blockquote)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted|moz-cite-prefix|divRplyFwdMsg)[^"']*["'][^>]*>/i,
  /<blockquote\b[^>]*(?:type\s*=\s*["']?cite["']?|cite\s*=)[^>]*>/i,
  /<hr\b[^>]*(?:id\s*=\s*["']?stopSpelling["']?)[^>]*>/i,
  /<!--[^>]*(?:Original Message|Begin forwarded message)[^>]*-->/i,
];

const HTML_SIGNATURE_MARKERS = [
  /<(?:div|span)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:gmail_signature|moz-signature)[^"']*["'][^>]*>/i,
];

const MOBILE_SIGNATURE_RE = /^(?:Sent from my (?:iPhone|iPad|Android device)|Get Outlook for (?:iOS|Android))\.?$/i;
const SIGN_OFF_RE = /^(?:best|best regards|kind regards|regards|thanks|thank you|cheers|sincerely),?$/i;

function hasMeaningfulText(value) {
  return /[\p{L}\p{N}]/u.test(value || '');
}

function hasAuthoredText(value) {
  const withoutSeparators = String(value || '')
    .replace(/^(?:-{2,}\s*)?(?:Original Message|Begin forwarded message|Forwarded message)(?:\s*-{2,})?:?$/gim, '')
    .replace(/^-{5,}$/gm, '');
  return hasMeaningfulText(withoutSeparators);
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '…',
    ldquo: '“',
    lsquo: '‘',
    lt: '<',
    mdash: '—',
    nbsp: ' ',
    ndash: '–',
    quot: '"',
    rdquo: '”',
    rsquo: '’',
  };

  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(value) {
  return normalizeWhitespace(
    decodeHtmlEntities(
      String(value || '')
        .replace(/<(?:script|style|head)\b[^>]*>[\s\S]*?<\/(?:script|style|head)>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:div|p|li|tr|h[1-6])\s*>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '')
    )
  );
}

function firstMarkerIndex(value, patterns) {
  let first = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match && (first === -1 || match.index < first)) first = match.index;
  }
  return first;
}

function looksLikeOnWroteBoundary(lines, index) {
  const first = lines[index].trim();
  if (!/^On\s+/i.test(first)) return false;

  for (let count = 1; count <= 4 && index + count <= lines.length; count++) {
    const combined = lines.slice(index, index + count).join(' ').replace(/\s+/g, ' ').trim();
    if (/^On\s+.{1,500}\bwrote:$/i.test(combined)) return true;
  }
  return false;
}

function looksLikeOutlookHeaderBoundary(lines, index) {
  if (!/^From:\s*\S+/i.test(lines[index].trim())) return false;

  const nearby = lines.slice(index, Math.min(lines.length, index + 9)).map(line => line.trim());
  const headerNames = nearby
    .map(line => line.match(/^(From|Sent|Date|To|Cc|Subject):/i)?.[1]?.toLowerCase())
    .filter(Boolean);

  return headerNames.includes('from')
    && (headerNames.includes('sent') || headerNames.includes('date'))
    && headerNames.includes('subject')
    && (headerNames.includes('to') || headerNames.includes('cc'));
}

function quotedTailStartsAt(lines, index) {
  if (!/^\s*>/.test(lines[index])) return false;
  const remaining = lines.slice(index).filter(line => line.trim());
  return remaining.length > 0 && remaining.every(line => /^\s*>/.test(line));
}

function findPlainQuoteBoundary(lines) {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (
      looksLikeOnWroteBoundary(lines, index)
      || looksLikeOutlookHeaderBoundary(lines, index)
      || /^(?:-{2,}\s*)?(?:Original Message|Begin forwarded message)(?:\s*-{2,})?:?$/i.test(line)
      || quotedTailStartsAt(lines, index)
    ) {
      const prefix = lines.slice(0, index).join('\n');
      if (hasAuthoredText(prefix)) return index;
    }
  }
  return -1;
}

function stripSignature(lines) {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    const isDelimiter = /^--\s*$/.test(line);
    const isMobileSignature = MOBILE_SIGNATURE_RE.test(line);
    const isSignOff = index >= Math.max(1, lines.length - 8) && SIGN_OFF_RE.test(line);
    if ((isDelimiter || isMobileSignature || isSignOff) && hasMeaningfulText(lines.slice(0, index).join('\n'))) {
      return lines.slice(0, index);
    }
  }
  return lines;
}

function splitPlainText(value) {
  const text = normalizeWhitespace(value);
  const lines = text.split('\n');
  const boundary = findPlainQuoteBoundary(lines);
  const authoredLines = boundary >= 0 ? lines.slice(0, boundary) : lines;
  const contextLines = boundary >= 0 ? lines.slice(boundary) : [];
  const latestContent = normalizeWhitespace(stripSignature(authoredLines).join('\n'));

  // An email that consists only of a forwarded/quoted message still needs that
  // content classified. Only split when there is real authored text above it.
  if (!hasMeaningfulText(latestContent)) {
    return { latestContent: text, threadContext: '', hadQuotedContent: false };
  }

  return {
    latestContent,
    threadContext: normalizeWhitespace(contextLines.join('\n')),
    hadQuotedContent: contextLines.length > 0,
  };
}

/**
 * Separate the newest authored portion of a reply from quoted history and
 * common signatures. The earlier thread remains available as bounded context
 * for the classifier, but is never mixed into the primary message body.
 */
export function normalizeMessageContent(body, { fallback = '' } = {}) {
  const raw = String(body || fallback || '');
  if (!raw.trim()) {
    return { latestContent: '', threadContext: '', hadQuotedContent: false, sourceFormat: 'plain' };
  }

  const sourceFormat = HTML_TAG_RE.test(raw) ? 'html' : 'plain';
  if (sourceFormat === 'plain') return { ...splitPlainText(raw), sourceFormat };

  const quoteIndex = firstMarkerIndex(raw, HTML_QUOTE_MARKERS);
  let authoredHtml = quoteIndex >= 0 ? raw.slice(0, quoteIndex) : raw;
  const quotedHtml = quoteIndex >= 0 ? raw.slice(quoteIndex) : '';
  const signatureIndex = firstMarkerIndex(authoredHtml, HTML_SIGNATURE_MARKERS);
  if (signatureIndex >= 0 && hasMeaningfulText(htmlToText(authoredHtml.slice(0, signatureIndex)))) {
    authoredHtml = authoredHtml.slice(0, signatureIndex);
  }

  const authored = splitPlainText(htmlToText(authoredHtml));
  const htmlThreadContext = htmlToText(quotedHtml);
  const latestContent = authored.latestContent;
  const threadContext = normalizeWhitespace([authored.threadContext, htmlThreadContext].filter(Boolean).join('\n\n'));

  if (!hasMeaningfulText(latestContent)) {
    return {
      latestContent: htmlToText(raw),
      threadContext: '',
      hadQuotedContent: false,
      sourceFormat,
    };
  }

  return {
    latestContent,
    threadContext,
    hadQuotedContent: Boolean(threadContext),
    sourceFormat,
  };
}
