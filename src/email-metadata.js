const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function normalizeEmailHeaderText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

export function splitEmailSender(value) {
  const raw = normalizeEmailHeaderText(value);
  const emailMatch = raw.match(EMAIL_PATTERN);
  const fromEmail = emailMatch?.[0] || '';
  const nameWithoutAddress = fromEmail ? raw.replace(fromEmail, '') : raw;
  const fromName = nameWithoutAddress
    .replace(/[<>"']/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const hasUsefulName = /[\p{L}\p{N}]/u.test(fromName);

  if (hasUsefulName) return { fromName, fromEmail };
  if (fromEmail) return { fromName: fromEmail.split('@')[0], fromEmail };
  return { fromName: 'Unknown', fromEmail: '' };
}
