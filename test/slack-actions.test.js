import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateUnsubscribeUrl } from '../src/slack-actions.js';

describe('unsubscribe URL safety', () => {
  it('allows mailto unsubscribe links without network validation', async () => {
    const url = await validateUnsubscribeUrl('mailto:unsubscribe@example.com');
    assert.equal(url.protocol, 'mailto:');
  });

  it('blocks localhost unsubscribe URLs', async () => {
    await assert.rejects(
      () => validateUnsubscribeUrl('http://localhost/unsubscribe'),
      /Blocked unsafe unsubscribe URL host/
    );
  });

  it('blocks private IPv4 unsubscribe URLs', async () => {
    await assert.rejects(
      () => validateUnsubscribeUrl('https://192.168.1.5/unsubscribe'),
      /Blocked unsafe unsubscribe URL host/
    );
  });

  it('blocks loopback IPv6 unsubscribe URLs', async () => {
    await assert.rejects(
      () => validateUnsubscribeUrl('http://[::1]/unsubscribe'),
      /Blocked unsafe unsubscribe URL host/
    );
  });

  it('blocks link-local IPv6 unsubscribe URLs', async () => {
    await assert.rejects(
      () => validateUnsubscribeUrl('http://[fe90::1]/unsubscribe'),
      /Blocked unsafe unsubscribe URL host/
    );
  });

  it('blocks IPv4-mapped loopback IPv6 unsubscribe URLs', async () => {
    await assert.rejects(
      () => validateUnsubscribeUrl('http://[::ffff:127.0.0.1]/unsubscribe'),
      /Blocked unsafe unsubscribe URL host/
    );
  });
});
