import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPushCapabilities, maybeSendPushForEmail } from '../src/push.js';

describe('push notification policy', () => {
  it('advertises registration without claiming delivery is enabled', () => {
    const capabilities = getPushCapabilities();
    assert.equal(capabilities.deviceRegistration, true);
    assert.equal(capabilities.delivery, false);
  });

  it('does not push archived emails', async () => {
    const result = await maybeSendPushForEmail({ archive: true, mailboxState: 'archived' });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'not_kept');
  });

  it('does not push kept emails until APNs is configured', async () => {
    const saved = {
      APNS_TEAM_ID: process.env.APNS_TEAM_ID,
      APNS_KEY_ID: process.env.APNS_KEY_ID,
      APNS_BUNDLE_ID: process.env.APNS_BUNDLE_ID,
      APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
    };
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_BUNDLE_ID;
    delete process.env.APNS_PRIVATE_KEY;
    const result = await maybeSendPushForEmail({ archive: false, mailboxState: 'inbox' });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'apns_not_configured');
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});
