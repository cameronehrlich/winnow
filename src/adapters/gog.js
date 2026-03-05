import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GmailAdapter } from './gmail.js';

const exec = promisify(execFile);
const GOG_FLAGS = ['--json', '--no-input'];

async function gogExec(args) {
  try {
    return await exec('gog', [...args, ...GOG_FLAGS], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('gog CLI not found. Install it: https://github.com/cameronehrlich/gog');
    throw e;
  }
}

function gogExecForce(args) {
  return exec('gog', [...args, ...GOG_FLAGS, '--force'], {
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    console.error(`[winnow] Failed to parse gog output: ${stdout.slice(0, 200)}`);
    return null;
  }
}

export class GogAdapter extends GmailAdapter {
  #labelCache = new Map();

  async fetchUnread(account, searchQuery = 'is:unread newer_than:1d', max = 50) {
    const { stdout } = await gogExec([
      'gmail', 'messages', 'search', searchQuery,
      '--max', String(max),
      '--account', account,
    ]);
    const data = parseJson(stdout);
    if (!data) return [];
    const messages = Array.isArray(data) ? data : (data.messages || []);
    return messages.map(msg => this.#normalizeMessage(msg));
  }

  async getMessage(account, messageId) {
    const { stdout } = await gogExec([
      'gmail', 'get', messageId,
      '--account', account,
    ]);
    return parseJson(stdout);
  }

  async archive(account, threadId) {
    return this.modifyLabels(account, threadId, { remove: ['INBOX'] });
  }

  async markRead(account, threadId) {
    return this.modifyLabels(account, threadId, { remove: ['UNREAD'] });
  }

  async addLabel(account, threadId, label) {
    return this.modifyLabels(account, threadId, { add: [label] });
  }

  async removeLabel(account, threadId, label) {
    return this.modifyLabels(account, threadId, { remove: [label] });
  }

  async modifyLabels(account, threadId, { add = [], remove = [] }) {
    const args = ['gmail', 'labels', 'modify', threadId, '--account', account];
    if (add.length) args.push('--add', add.join(','));
    if (remove.length) args.push('--remove', remove.join(','));
    const { stdout } = await gogExecForce(args);
    return parseJson(stdout);
  }

  async ensureLabel(account, labelName) {
    const cacheKey = `${account}:${labelName}`;
    if (this.#labelCache.has(cacheKey)) return;

    try {
      const { stdout } = await gogExec([
        'gmail', 'labels', 'list',
        '--account', account,
      ]);
      const labels = parseJson(stdout);
      const exists = Array.isArray(labels) && labels.some(
        l => (l.name || l.Name || '') === labelName
      );
      if (!exists) {
        await gogExec([
          'gmail', 'labels', 'create', labelName,
          '--account', account,
        ]);
      }
      this.#labelCache.set(cacheKey, true);
    } catch {
      // Label might already exist, that's fine
      this.#labelCache.set(cacheKey, true);
    }
  }

  #normalizeMessage(msg) {
    const headers = msg.payload?.headers || msg.headers || [];
    const getHeader = (name) => {
      const h = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
      return h?.value || '';
    };

    return {
      id: msg.id || msg.Id || '',
      threadId: msg.threadId || msg.ThreadId || '',
      snippet: msg.snippet || msg.Snippet || '',
      subject: getHeader('Subject') || msg.subject || msg.Subject || '',
      from: getHeader('From') || msg.from || msg.From || '',
      to: getHeader('To') || msg.to || msg.To || '',
      date: getHeader('Date') || msg.date || msg.Date || '',
      labelIds: msg.labelIds || msg.LabelIds || [],
      headers,
    };
  }
}
