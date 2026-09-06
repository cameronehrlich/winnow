import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { headerAddresses, resolveMailIdentity } from '../src/mail-identity.js';

const account = 'support@example.com';
const sendAs = [
  { sendAsEmail: account, isPrimary: true },
  { sendAsEmail: 'info@brand.com', verificationStatus: 'accepted' },
  { sendAsEmail: 'support@second.com', verificationStatus: 'accepted' },
  { sendAsEmail: 'pending@brand.com', verificationStatus: 'pending' },
];
const resolve = (message, config) => resolveMailIdentity(account, message, sendAs, config);

describe('mailbox sending identity', () => {
  it('uses the addressed verified brand, not the authentication mailbox', () => {
    assert.equal(resolve({ to: 'Brand <INFO@brand.com>' }).from, 'info@brand.com');
    assert.equal(resolve({ to: `${account}, info@brand.com` }).from, 'info@brand.com');
    assert.equal(resolve({ to: account }).from, account);
  });
  it('supports Cc, envelope recipients and sent follow-ups', () => {
    assert.equal(resolve({ cc: 'info@brand.com' }).from, 'info@brand.com');
    assert.equal(resolve({ headers: [{ name: 'X-Original-To', value: 'info@brand.com' }] }).from, 'info@brand.com');
    assert.equal(resolve({ labelIds: ['SENT'], from: 'info@brand.com', to: 'customer@example.org' }).from, 'info@brand.com');
  });
  it('does not select addresses in a display name or message body', () => {
    assert.deepEqual(headerAddresses('"info@brand.com, Sales" <customer@example.org>'), ['customer@example.org']);
    assert.equal(resolve({ to: '"info@brand.com" <customer@example.org>', body: 'From: info@brand.com' }).from, account);
  });
  it('fails explicitly for unverified or ambiguous brand identities', () => {
    assert.throws(() => resolve({ to: 'pending@brand.com' }), { code: 'sender_not_verified' });
    assert.throws(() => resolve({ to: 'future@brand.com' }, { receiving_aliases: ['future@brand.com'] }), { code: 'sender_not_verified' });
    assert.throws(() => resolve({ to: 'info@brand.com, support@second.com' }), { code: 'sender_ambiguous' });
    assert.throws(() => resolveMailIdentity(account, {}, []), { code: 'sender_unavailable' });
  });
});
