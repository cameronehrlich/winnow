// Mailbox credentials and customer-facing sender identity are distinct. Only
// Gmail-verified identities can be selected; message content is never consulted.
export function headerAddresses(value) {
  const parts = String(value || '').match(/(?:"(?:\\.|[^"\\])*"|[^,])+/g) || [];
  return parts.flatMap(part => {
    const address = (part.match(/<([^<>]+)>/)?.[1] || part).trim().toLowerCase();
    return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address) ? [address] : [];
  });
}

function identityError(code, message) {
  return Object.assign(new Error(message), { code, status: 409 });
}

export function resolveMailIdentity(account, message, sendAs, config = {}) {
  const primary = account.toLowerCase();
  if (!Array.isArray(sendAs) || !sendAs.some(alias => alias.isPrimary || alias.verificationStatus === 'accepted')) {
    throw identityError('sender_unavailable', 'Gmail sending addresses could not be verified. Please try again.');
  }
  const verified = new Set(sendAs.filter(alias => alias.isPrimary || alias.verificationStatus === 'accepted')
    .map(alias => String(alias.sendAsEmail).toLowerCase()));
  const owned = new Set([primary, ...sendAs.map(alias => String(alias.sendAsEmail).toLowerCase()),
    ...(config.receiving_aliases || []).map(alias => String(alias).toLowerCase())]);
  const raw = message?.headers || message?.payload?.headers || {};
  const headers = Object.fromEntries((Array.isArray(raw)
    ? raw.map(header => [header.name, header.value]) : Object.entries(raw))
    .map(([name, value]) => [String(name).toLowerCase(), value]));
  const sent = (message?.labelIds || []).includes('SENT');
  const groups = sent
    ? [headers.from || message.from]
    : [headers.to || message.to, headers.cc || message.cc,
      headers['x-original-to'], headers['delivered-to'], headers.bcc || message.bcc];
  let from;
  for (const group of groups) {
    let matches = [...new Set(headerAddresses(group).filter(address => owned.has(address)))];
    // A routing mailbox in the same header should not obscure the brand alias.
    if (matches.some(address => address !== primary)) matches = matches.filter(address => address !== primary);
    if (matches.length > 1) throw identityError('sender_ambiguous', 'This email was addressed to multiple sending identities. Choose a single From address in Gmail.');
    if (matches.length) { [from] = matches; break; }
  }
  from ||= primary;
  if (!verified.has(from)) {
    throw identityError('sender_not_verified', `Set up ${from} as a verified Gmail sending address before replying. Winnow will not substitute another address.`);
  }
  return { from, ownedAddresses: [...owned] };
}
