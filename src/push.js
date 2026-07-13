import { readFileSync } from 'node:fs';
import { connect } from 'node:http2';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import {
  disablePushDevice,
  getMailboxCounts,
  listPushDevices,
  recordPushDelivery,
} from './store.js';

const APNS_HOSTS = {
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};
const TOKEN_TTL_SECONDS = 50 * 60;
let cachedProviderToken;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function privateKeyValue(env = process.env) {
  if (env.APNS_PRIVATE_KEY_PATH) return readFileSync(env.APNS_PRIVATE_KEY_PATH, 'utf8');
  if (!env.APNS_PRIVATE_KEY) return '';
  const raw = env.APNS_PRIVATE_KEY.trim();
  if (raw.startsWith('base64:')) return Buffer.from(raw.slice(7), 'base64').toString('utf8');
  return raw.replace(/\\n/g, '\n');
}

export function getApnsConfiguration(env = process.env) {
  let privateKey = '';
  let keyError = '';
  try {
    privateKey = privateKeyValue(env);
    if (privateKey) createPrivateKey(privateKey);
  } catch (error) {
    keyError = error.message;
  }
  const configuration = {
    teamId: env.APNS_TEAM_ID?.trim() || '',
    keyId: env.APNS_KEY_ID?.trim() || '',
    bundleId: env.APNS_BUNDLE_ID?.trim() || '',
    privateKey,
  };
  const missing = Object.entries(configuration)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  return {
    ...configuration,
    configured: missing.length === 0 && !keyError,
    missing,
    keyError,
  };
}

export function getPushCapabilities() {
  const config = getApnsConfiguration();
  return {
    deviceRegistration: true,
    delivery: config.configured,
    configured: config.configured,
    environments: Object.keys(APNS_HOSTS),
    reason: config.configured ? null : (config.keyError ? 'apns_private_key_invalid' : 'apns_not_configured'),
  };
}

function providerToken(config, now = Math.floor(Date.now() / 1000)) {
  if (
    cachedProviderToken
    && cachedProviderToken.keyId === config.keyId
    && cachedProviderToken.teamId === config.teamId
    && now - cachedProviderToken.issuedAt < TOKEN_TTL_SECONDS
  ) return cachedProviderToken.value;

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: now }));
  const input = `${header}.${claims}`;
  const signature = sign(null, Buffer.from(input), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  cachedProviderToken = {
    keyId: config.keyId,
    teamId: config.teamId,
    issuedAt: now,
    value: `${input}.${signature}`,
  };
  return cachedProviderToken.value;
}

function notificationPayload(item, badge, { silent = false } = {}) {
  const emailId = item?.id || item?.emailItemId || '';
  const common = {
    event: item?.mailboxState === 'archived' || item?.archive ? 'email.archived' : 'email.kept',
    emailId,
    mailboxState: item?.mailboxState || (item?.archive ? 'archived' : 'inbox'),
  };
  if (silent) return { aps: { 'content-available': 1, badge }, ...common };
  const truncate = (value, length) => String(value || '').slice(0, length);
  const sender = truncate(item?.fromName || item?.fromEmail || item?.from || 'New email', 120);
  const summary = truncate(item?.summary || item?.subject || 'Open Winnow to review.', 700);
  return {
    aps: {
      alert: { title: sender, subtitle: truncate(item?.subject, 200), body: summary },
      sound: 'default',
      badge,
      'content-available': 1,
      'mutable-content': 0,
    },
    ...common,
  };
}

function isPermanentTokenFailure(status, reason) {
  return status === 410 || [
    'BadDeviceToken',
    'DeviceTokenNotForTopic',
    'MissingDeviceToken',
    'Unregistered',
  ].includes(reason);
}

export function sendApnsRequest({ device, payload, config, timeoutMs = 10_000 }) {
  const environment = APNS_HOSTS[device.environment] ? device.environment : 'production';
  const host = APNS_HOSTS[environment];
  const body = JSON.stringify(payload);
  const apnsId = randomUUID();

  return new Promise((resolve, reject) => {
    const client = connect(host);
    let settled = false;
    const timer = setTimeout(() => {
      client.destroy();
      finish(reject, new Error('APNs request timed out'));
    }, timeoutMs);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      callback(value);
    };
    client.once('error', error => finish(reject, error));
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${device.deviceToken}`,
      authorization: `bearer ${providerToken(config)}`,
      'apns-topic': device.bundleId || config.bundleId,
      'apns-push-type': payload.aps?.alert ? 'alert' : 'background',
      'apns-priority': payload.aps?.alert ? '10' : '5',
      'apns-id': apnsId,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    let status = 0;
    let response = '';
    request.setEncoding('utf8');
    request.on('response', headers => { status = Number(headers[':status'] || 0); });
    request.on('data', chunk => { response += chunk; });
    request.on('error', error => finish(reject, error));
    request.on('end', () => {
      let reason = '';
      try { reason = response ? JSON.parse(response).reason || '' : ''; } catch { reason = response; }
      finish(resolve, { ok: status === 200, status, reason, apnsId, environment });
    });
    request.end(body);
  });
}

export async function maybeSendPushForEmail(item, opts = {}) {
  if (!item) return { sent: false, reason: 'missing_item' };
  const config = opts.config || getApnsConfiguration();
  if (!config.configured) {
    return { sent: false, reason: config.keyError ? 'apns_private_key_invalid' : 'apns_not_configured' };
  }
  const devices = opts.devices || listPushDevices();
  if (!devices.length) return { sent: false, reason: 'no_registered_devices' };

  const archived = Boolean(item.archive || item.mailboxState === 'archived');
  const badge = (opts.mailboxCounts || getMailboxCounts()).inbox;
  const payload = notificationPayload(item, badge, { silent: archived });
  const send = opts.send || sendApnsRequest;
  const results = await Promise.all(devices.map(async device => {
    try {
      const result = await send({ device, payload, config });
      recordPushDelivery(device.id, result);
      if (!result.ok && isPermanentTokenFailure(result.status, result.reason)) {
        disablePushDevice(device.id, result.reason || `APNs ${result.status}`);
      }
      return { deviceId: device.id, ...result };
    } catch (error) {
      recordPushDelivery(device.id, { ok: false, status: 0, reason: error.message });
      return { deviceId: device.id, ok: false, status: 0, reason: error.message };
    }
  }));
  const sentCount = results.filter(result => result.ok).length;
  return {
    sent: sentCount > 0,
    sentCount,
    failedCount: results.length - sentCount,
    silent: archived,
    reason: sentCount ? null : 'delivery_failed',
    results,
  };
}

export function resetProviderTokenForTests() {
  cachedProviderToken = undefined;
}
