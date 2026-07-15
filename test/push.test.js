import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  getApnsConfiguration,
  getPushCapabilities,
  maybeSendPushForEmail,
  sendBadgeSync,
  WINNOW_EMAIL_NOTIFICATION_CATEGORY,
} from '../src/push.js';

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
      account: 'me@example.com',
      threadId: 'thread-1',
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
    assert.equal(request.payload.aps.category, WINNOW_EMAIL_NOTIFICATION_CATEGORY);
    assert.match(request.payload.aps['thread-id'], /^gmail-[a-f0-9]{40}$/);
    assert.equal(request.payload.emailId, 'email-1');
    assert.equal(request.payload.threadId, 'thread-1');
    assert.equal(request.payload.account, 'me@example.com');
  });

  it('uses a stable account-specific group for the same Gmail thread', async () => {
    const groups = [];
    const send = async request => {
      groups.push(request.payload.aps['thread-id']);
      return { ok: true, status: 200, reason: '', apnsId: `push-${groups.length}` };
    };
    const opts = {
      config: testConfiguration(), devices: [device], mailboxCounts: { inbox: 2 }, send,
    };
    await maybeSendPushForEmail({
      id: 'email-1', account: 'me@example.com', threadId: 'thread-1', mailboxState: 'inbox',
    }, opts);
    await maybeSendPushForEmail({
      id: 'email-2', account: 'me@example.com', threadId: 'thread-1', mailboxState: 'inbox',
    }, opts);
    await maybeSendPushForEmail({
      id: 'email-3', account: 'other@example.com', threadId: 'thread-1', mailboxState: 'inbox',
    }, opts);

    assert.equal(groups[0], groups[1]);
    assert.notEqual(groups[0], groups[2]);
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

  it('sends a silent authoritative badge synchronization', async () => {
    let request;
    const result = await sendBadgeSync({
      config: testConfiguration(),
      devices: [device],
      mailboxCounts: { inbox: 4, archived: 12 },
      send: async value => {
        request = value;
        return { ok: true, status: 200, reason: '', apnsId: 'badge-1' };
      },
    });

    assert.equal(result.sent, true);
    assert.equal(result.silent, true);
    assert.equal(result.badge, 4);
    assert.deepEqual(request.payload, {
      aps: { 'content-available': 1, badge: 4 },
      event: 'badge.sync',
    });
  });

  it('includes exact archived email identities for device notification cleanup', async () => {
    let request;
    await sendBadgeSync({
      config: testConfiguration(),
      devices: [device],
      mailboxCounts: { inbox: 1, archived: 12 },
      clearNotifications: [
        { id: 'email-1', account: 'me@example.com', threadId: 'thread-1', mailboxState: 'archived' },
        { id: 'email-1', account: 'me@example.com', threadId: 'thread-1', mailboxState: 'archived' },
        { id: 'email-2', account: 'me@example.com', threadId: 'thread-2', mailboxState: 'inbox' },
      ],
      send: async value => {
        request = value;
        return { ok: true, status: 200, reason: '', apnsId: 'badge-2' };
      },
    });

    assert.deepEqual(request.payload.clearNotifications, [
      { emailId: 'email-1', account: 'me@example.com', threadId: 'thread-1' },
      { emailId: 'email-2', account: 'me@example.com', threadId: 'thread-2' },
    ]);
  });
});
