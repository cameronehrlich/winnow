import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMailboxSync } from '../src/mailbox-sync.js';

describe('mailbox sync coordinator', () => {
  it('joins simultaneous refreshes and isolates slow accounts', async () => {
    let finish;
    const calls = [];
    const coordinator = createMailboxSync({ sync: async account => {
      calls.push(account);
      if (account === 'slow') await new Promise(resolve => { finish = resolve; });
      return {};
    } });
    const [a, b] = await Promise.all([
      coordinator.refresh(['slow', 'fast'], { waitMs: 5 }),
      coordinator.refresh(['slow', 'fast'], { waitMs: 5 }),
    ]);
    assert.deepEqual(calls, ['slow', 'fast']);
    assert.equal(a.state, 'syncing');
    assert.equal(b.accounts[1].syncing, false);
    assert.ok(b.accounts[1].lastSuccessAt);
    finish();
    assert.equal((await coordinator.refresh(['slow', 'fast'])).state, 'current');
  });

  it('throttles repeated attempts, exposes failure, and retries without losing last success', async () => {
    let time = 100_000, fails = false, calls = 0;
    const coordinator = createMailboxSync({ now: () => time, sync: async () => {
      calls++;
      if (fails) throw new Error('private provider details');
      return {};
    } });
    const first = await coordinator.refresh(['a']);
    await coordinator.refresh(['a']);
    assert.equal(calls, 1);
    time += 30_000; fails = true;
    const failed = await coordinator.refresh(['a']);
    assert.equal(failed.state, 'error');
    assert.equal(failed.accounts[0].lastSuccessAt, first.accounts[0].lastSuccessAt);
    assert.equal(failed.accounts[0].error, 'gmail_sync_failed');
    time += 30_000; fails = false;
    assert.equal((await coordinator.refresh(['a'])).state, 'current');
    assert.equal(calls, 3);
  });

  it('sends notification cleanup once and does not wait for push delivery', async () => {
    const notifications = [];
    const coordinator = createMailboxSync({
      sync: async () => ({ changed: 1, changes: [{ id: 'a', mailboxState: 'archived' }] }),
      notify: async payload => { notifications.push(payload); await new Promise(() => {}); },
    });
    assert.equal((await coordinator.refresh(['a'])).state, 'current');
    await coordinator.refresh(['a']);
    assert.deepEqual(notifications, [{ clearNotifications: [{ id: 'a', mailboxState: 'archived' }] }]);
  });

  it('an explicit refresh checks Gmail even just after a completed background check', async () => {
    let calls = 0;
    const coordinator = createMailboxSync({ sync: async () => { calls++; return {}; } });
    await coordinator.refresh(['a']);
    await coordinator.refresh(['a'], { force: true });
    assert.equal(calls, 2);
  });
});
