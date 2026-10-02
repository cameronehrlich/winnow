// One recipient/draft contract for model output, stored drafts and outbound
// tools. Display names are accepted, but only exact addresses reach Gmail.
export class DraftValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid_draft';
  }
}

const EMAIL_ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function validateSubject(subject) {
  if (typeof subject !== 'string' || subject.length > 500 || CONTROL_CHARACTERS.test(subject)) {
    throw new DraftValidationError('Check the subject. It must be one line, up to 500 characters.');
  }
  return subject;
}

export function normalizeMailRecipients(value, field, { required = false } = {}) {
  const label = { to: 'To', cc: 'Cc', bcc: 'Bcc' }[field] || field;
  if (!Array.isArray(value) || value.length > 20 || (required && !value.length)) {
    throw new DraftValidationError(`Add ${required ? 'at least one' : 'valid'} ${label} email address (up to 20).`);
  }
  const normalized = value.map(entry => {
    if (typeof entry !== 'string' || entry.length > 320 || CONTROL_CHARACTERS.test(entry)) {
      throw new DraftValidationError(`Check the ${label} recipients. Each must contain one valid email address.`);
    }
    const input = entry.trim();
    // Require the entire entry to be one mailbox, not a partial match from an
    // ambiguous list, trailing text or multiple angle-bracket addresses.
    const mailbox = input.match(/^(?:"(?:[^"\\]|\\.)*"|[^<>"\r\n]*)\s*<([^<>]+)>$/);
    const address = mailbox ? mailbox[1].trim() : input;
    const [local, domain] = address.split('@');
    if (!EMAIL_ADDRESS.test(address) || address.length > 254 || local.length > 64
        || local.startsWith('.') || local.endsWith('.') || local.includes('..')
        || domain.split('.').some(part => part.length > 63)) {
      throw new DraftValidationError(`Check the ${label} recipients. Each must contain one valid email address.`);
    }
    return address.toLowerCase();
  });
  return [...new Set(normalized)];
}

export function normalizeOutboundDraft(draft, kind) {
  const bodyField = kind === 'reply' ? 'body' : 'note';
  const body = draft[bodyField] ?? (kind === 'forward' ? '' : undefined);
  if (typeof body !== 'string' || body.length > 20000 || (kind === 'reply' && !body.trim())) {
    throw new DraftValidationError('Add a message of up to 20,000 characters before sending.');
  }
  const result = { [bodyField]: body };
  const seen = new Set();
  for (const field of ['to', 'cc', 'bcc']) {
    if (draft[field] === undefined && !(kind === 'forward' && field === 'to')) continue;
    const addresses = normalizeMailRecipients(draft[field], field, { required: kind === 'forward' && field === 'to' });
    // To, then Cc, then Bcc: never add a recipient or promote a Bcc-only address.
    result[field] = addresses.filter(address => {
      if (seen.has(address)) return false;
      seen.add(address);
      return true;
    });
  }
  if (kind === 'reply' && draft.subject !== undefined) {
    result.subject = validateSubject(draft.subject);
  }
  if (kind === 'forward') result.skipAttachments = draft.skipAttachments === true;
  return result;
}

export function normalizeAssistantDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || !['reply', 'forward'].includes(draft.kind)) return null;
  const body = draft.body ?? draft.note ?? '';
  const raw = {
    to: draft.to ?? [], cc: draft.cc ?? [], bcc: draft.bcc ?? [],
    subject: draft.subject ?? '', [draft.kind === 'reply' ? 'body' : 'note']: body,
  };
  try {
    if (typeof draft.validationError === 'string' && draft.validationError) {
      throw new DraftValidationError(draft.validationError);
    }
    validateSubject(raw.subject);
    const normalized = normalizeOutboundDraft(raw, draft.kind);
    return {
      kind: draft.kind, to: normalized.to, cc: normalized.cc, bcc: normalized.bcc,
      subject: raw.subject, body, validationError: null,
    };
  } catch (error) {
    if (!(error instanceof DraftValidationError)) throw error;
    // Keep a bounded, visibly invalid draft so the user can ask for a correction.
    // Never silently discard malformed recipients or truncate into a sendable draft.
    const visible = value => Array.isArray(value)
      ? value.filter(entry => typeof entry === 'string').slice(0, 20).map(entry => entry.slice(0, 320)) : [];
    return {
      kind: draft.kind, to: visible(raw.to), cc: visible(raw.cc), bcc: visible(raw.bcc),
      subject: typeof raw.subject === 'string' ? raw.subject.slice(0, 500) : '',
      body: typeof body === 'string' ? body.slice(0, 20000) : '',
      validationError: error.message,
    };
  }
}
