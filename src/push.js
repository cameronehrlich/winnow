function apnsConfigured() {
  return Boolean(
    process.env.APNS_TEAM_ID &&
    process.env.APNS_KEY_ID &&
    process.env.APNS_BUNDLE_ID &&
    process.env.APNS_PRIVATE_KEY
  );
}

export function getPushCapabilities() {
  const configured = apnsConfigured();
  return {
    deviceRegistration: true,
    delivery: false,
    configured,
    reason: configured ? 'apns_dispatch_not_enabled' : 'apns_not_configured',
  };
}

export async function maybeSendPushForEmail(item) {
  if (!item || item.archive || item.mailboxState === 'archived') {
    return { sent: false, reason: 'not_kept' };
  }

  if (!apnsConfigured()) {
    return { sent: false, reason: 'apns_not_configured' };
  }

  // APNs credential plumbing and device registration exist now; the actual APNs
  // HTTP/2 dispatch can be enabled once the iOS app bundle and key are ready.
  return { sent: false, reason: 'apns_dispatch_not_enabled' };
}
