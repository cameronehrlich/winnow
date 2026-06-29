/**
 * Abstract Gmail adapter interface.
 * All Gmail adapters must implement these methods.
 */
export class GmailAdapter {
  async fetchUnread(account, searchQuery, max) {
    throw new Error('Not implemented');
  }

  async archive(account, threadId) {
    throw new Error('Not implemented');
  }

  async markRead(account, threadId) {
    throw new Error('Not implemented');
  }

  async addLabel(account, threadId, label) {
    throw new Error('Not implemented');
  }

  async removeLabel(account, threadId, label) {
    throw new Error('Not implemented');
  }

  async modifyLabels(account, threadId, { add, remove }) {
    throw new Error('Not implemented');
  }

  async getMessage(account, messageId) {
    throw new Error('Not implemented');
  }

  async ensureLabel(account, labelName) {
    throw new Error('Not implemented');
  }

  async getMailboxState(account, messageId) {
    throw new Error('Not implemented');
  }
}
