import { GogAdapter } from './adapters/gog.js';
import { discoverUnsubscribeMethods } from './unsubscribe-discovery.js';
import { followUnsubscribeLink } from './slack-actions.js';

const adapter = new GogAdapter();

function methodForUrl(url, source) {
  try {
    const parsed = new URL(url);
    const type = ['http:', 'https:'].includes(parsed.protocol)
      ? 'http'
      : (parsed.protocol === 'mailto:' ? 'mailto' : null);
    return type ? { type, url: parsed.toString(), source, oneClick: false } : null;
  } catch {
    return null;
  }
}

function uniqueMethods(methods) {
  const seen = new Set();
  return methods.filter(method => {
    if (!method?.url || seen.has(method.url)) return false;
    seen.add(method.url);
    return true;
  }).sort((left, right) => {
    if (left.type === right.type) return 0;
    return left.type === 'http' ? -1 : 1;
  });
}

/**
 * Execute the best available unsubscribe method for a tracked message.
 *
 * The stored List-Unsubscribe URL remains first among automatable methods
 * because it is the strongest sender-provided signal. If it is broken,
 * rediscover semantically labelled alternatives from the original message and
 * try those before falling back to a manual mailto method.
 */
export async function executeEmailUnsubscribe(item, {
  getMessage = (account, messageId) => adapter.getMessage(account, messageId),
  follow = followUnsubscribeLink,
} = {}) {
  const stored = methodForUrl(item?.unsubscribeLink, 'stored');
  let discovered = [];
  try {
    const message = await getMessage(item.account, item.messageId);
    discovered = discoverUnsubscribeMethods(message).methods;
  } catch (error) {
    if (!stored) throw error;
  }

  const methods = uniqueMethods([stored, ...discovered].filter(Boolean));
  if (!methods.length) throw new Error('No unsubscribe method was found');

  const failures = [];
  let browserFallback = null;
  for (const method of methods) {
    try {
      return await follow(method.url);
    } catch (error) {
      failures.push(error);
      if (
        method.type === 'http'
        && /(?:GET|Form submit|One-click POST) returned HTTP [45]\d\d/.test(error.message)
      ) {
        browserFallback = method;
      }
    }
  }
  if (browserFallback) {
    return {
      status: 'attempted',
      method: 'browser',
      note: 'Sender requires completion in a browser',
      urlHost: new URL(browserFallback.url).hostname,
      manualActionUrl: browserFallback.url,
    };
  }
  throw failures.at(-1) || new Error('Unsubscribe failed');
}
