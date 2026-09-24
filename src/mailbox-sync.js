import { getActiveAccounts } from './config.js';
import { syncGmailMailbox } from './gmail-sync.js';
import { sendBadgeSync } from './push.js';

// One owner per account: background ticks and app refreshes join the same work.
export function createMailboxSync({ sync = syncGmailMailbox, notify = sendBadgeSync, now = Date.now } = {}) {
  const states = new Map();

  function status(account) {
    const state = states.get(account);
    return {
      account,
      syncing: Boolean(state?.promise),
      lastSuccessAt: state?.lastSuccessAt || null,
      error: state?.error || null,
    };
  }

  function run(account, force) {
    let state = states.get(account);
    if (!state) { state = {}; states.set(account, state); }
    if (state.promise) return state.promise;
    // Coalesce adjacent iPhone/iPad refreshes, including failed attempts.
    if (!force && state.lastAttemptAt != null && now() - state.lastAttemptAt < 15_000) return Promise.resolve();
    state.lastAttemptAt = now();
    state.promise = Promise.resolve().then(() => sync(account)).then(result => {
      state.lastSuccessAt = new Date(now()).toISOString();
      state.error = null;
      if (result.changed || result.imported || result.classified) {
        // APNs is a hint, not part of the Gmail cursor transaction. A slow push
        // service must not block reading or syncing mail.
        void Promise.resolve().then(() => notify({
          clearNotifications: (result.changes || []).filter(item => (
            item.mailboxState === 'archived' || item.readState === 'read'
          )),
        })).catch(() => console.error('[winnow/sync] Notification update failed'));
      }
    }).catch(() => {
      state.error = 'gmail_sync_failed';
      console.error(`[winnow/sync] Gmail sync failed for ${account}; will retry`);
    }).finally(() => { state.promise = null; });
    return state.promise;
  }

  async function refresh(accounts, { waitMs = 4000, force = false } = {}) {
    let timer;
    try {
      await Promise.race([
        Promise.all(accounts.map(account => run(account, force))),
        new Promise(resolve => { timer = setTimeout(resolve, waitMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const results = accounts.map(status);
    return {
      accounts: results,
      state: results.some(item => item.error) ? 'error'
        : results.some(item => item.syncing || !item.lastSuccessAt) ? 'syncing' : 'current',
    };
  }
  return { refresh, status };
}

export const mailboxSync = createMailboxSync();
export function refreshMailboxes(options) {
  return mailboxSync.refresh(getActiveAccounts().map(account => account.email), options);
}
