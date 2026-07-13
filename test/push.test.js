import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { getApnsConfiguration, getPushCapabilities, maybeSendPushForEmail } from '../src/push.js';

function testConfiguration() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    teamId: 'TEAM123456',
    keyId: 'KEY1234567',
    bundleId: 'com.example.Winnow',
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    configured: true,
    missing: [],
    keyError: '',
  };
}

const device = {
  id: 'device-1',
  deviceToken: 'a'.repeat(64),
  environment: 'development',
  bundleId: 'com.example.Winnow',
};

describe('push notification policy', () => {
  it('advertises registration without claiming delivery when credentials are absent', () => {
    const capabilities = getPushCapabilities();
    assert.equal(capabilities.deviceRegistration, true);
    assert.equal(capabilities.delivery, false);
  });

  it('validates malformed private key configuration without exposing the key', () => {
    const config = getApnsConfiguration({
      APNS_TEAM_ID: 'TEAM', APNS_KEY_ID: 'KEY', APNS_BUNDLE_ID: 'com.example.Winnow', APNS_PRIVATE_KEY: 'not-a-key',
    });
    assert.equal(config.configured, false);
    assert.ok(config.keyError);
  });

  it('sends an alert for kept inbox email with the current inbox badge', async () => {
    let request;
    const result = await maybeSendPushForEmail({
      id: 'email-1',
      fromName: 'Riley',
      subject: 'Question',
      summary: 'Can you review this?',
      mailboxState: 'inbox',
    }, {
      config: testConfiguration(),
      devices: [device],
      mailboxCounts: { inbox: 3, archived: 10 },
      send: async value => {
        request = value;
        return { ok: true, status: 200, reason: '', apnsId: 'push-1' };
      },
    });
    assert.equal(result.sent, true);
    assert.equal(request.payload.aps.badge, 3);
    assert.equal(request.payload.aps.alert.title, 'Riley');
    assert.equal(request.payload.emailId, 'email-1');
  });

  it('uses a silent background update for archived mail', async () => {
    let payload;
    const result = await maybeSendPushForEmail({ id: 'email-2', mailboxState: 'archived', archive: true }, {
      config: testConfiguration(),
      devices: [device],
      mailboxCounts: { inbox: 2, archived: 11 },
      send: async request => {
        payload = request.payload;
        return { ok: true, status: 200, reason: '', apnsId: 'push-2' };
      },
    });
    assert.equal(result.sent, true);
    assert.equal(result.silent, true);
    assert.equal(payload.aps['content-available'], 1);
    assert.equal(payload.aps.alert, undefined);
    assert.equal(payload.aps.badge, 2);
  });

  it('does not push kept emails until APNs is configured', async () => {
    const result = await maybeSendPushForEmail({ archive: false, mailboxState: 'inbox' }, {
      config: { configured: false, keyError: '' },
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'apns_not_configured');
  });
});
