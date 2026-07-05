import { getAccounts, getSlackActionRoutings, getSlackRoutingForAccount } from './config.js';
import { loadState } from './state.js';
import { getLatestEventsByAccount } from './store.js';

const STATUS_EVENT_TYPES = [
  'email.scanned',
  'email.kept',
  'email.auto_archived',
  'email.manual_archived',
  'email.restored_to_inbox',
  'delivery.slack_posted',
  'mailbox.state_changed',
  'email.unsubscribed',
  'email.unsubscribe_attempted',
  'email.unsubscribe_failed',
];

function routeKind(account) {
  return account.slack ? 'account_slack' : account.channel ? 'account_channel' : 'default';
}

export function listAccountStatus() {
  const accounts = getAccounts();
  const state = loadState();
  const latestEvents = getLatestEventsByAccount({
    accounts: accounts.map(account => account.email),
    eventTypes: STATUS_EVENT_TYPES,
  });

  return accounts.map(account => {
    const route = getSlackRoutingForAccount(account.email);
    const lastScan = state.lastScanCountsByAccount?.[account.email] || null;
    const latestEvent = latestEvents[account.email] || null;
    return {
      email: account.email,
      slack: {
        channelId: route.channelId,
        routeKind: routeKind(account),
        hasBotToken: Boolean(route.botToken),
        hasAppToken: Boolean(route.appToken),
        feedEnabled: Boolean(route.channelId && route.botToken),
        actionsEnabled: Boolean(route.botToken && route.appToken),
      },
      scan: {
        lastScanAt: state.lastScanByAccount?.[account.email] || lastScan?.scannedAt || null,
        lastScanFound: lastScan?.unreadFound ?? null,
        lastScanProcessed: lastScan?.processed ?? null,
      },
      latestEvent: latestEvent ? {
        id: latestEvent.id,
        eventType: latestEvent.eventType,
        timestamp: latestEvent.timestamp,
        subject: latestEvent.email?.subject || '',
      } : null,
    };
  });
}

export function getRuntimeStatus() {
  const state = loadState();
  return {
    ok: true,
    timestamp: new Date().toISOString(),
    process: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
    },
    scans: {
      lastScanTime: state.lastScanTime || null,
      lastScanByAccount: state.lastScanByAccount || {},
    },
    slack: {
      actionRouteCount: getSlackActionRoutings().length,
      actionRoutes: getSlackActionRoutings().map(route => ({
        account: route.account || 'default',
        channelId: route.channelId,
        hasBotToken: Boolean(route.botToken),
        hasAppToken: Boolean(route.appToken),
      })),
    },
    accounts: listAccountStatus(),
  };
}
