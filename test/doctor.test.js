import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  extractGogLabelIds,
  extractGogLabels,
  extractGogMessages,
  parseGogVersion,
} from '../src/doctor.js';

describe('doctor helpers', () => {
  it('parses gog version output from current and older releases', () => {
    assert.equal(parseGogVersion('0.31.1 (Homebrew 2026-06-26T06:35:28Z)'), '0.31.1');
    assert.equal(parseGogVersion('v0.11.0 (91c4c15 2026-02-15T03:29:18Z)'), '0.11.0');
  });

  it('compares semantic versions', () => {
    assert.equal(compareVersions('0.31.1', '0.31.1'), 0);
    assert.ok(compareVersions('0.31.2', '0.31.1') > 0);
    assert.ok(compareVersions('0.30.9', '0.31.1') < 0);
  });

  it('extracts gog labels from legacy arrays and current envelopes', () => {
    const labels = [{ name: 'INBOX' }];
    assert.deepEqual(extractGogLabels(labels), labels);
    assert.deepEqual(extractGogLabels({ labels }), labels);
    assert.equal(extractGogLabels({ unexpected: labels }), null);
  });

  it('extracts gog messages from legacy arrays and current envelopes', () => {
    const messages = [{ id: 'm1' }];
    assert.deepEqual(extractGogMessages(messages), messages);
    assert.deepEqual(extractGogMessages({ messages }), messages);
    assert.equal(extractGogMessages({ unexpected: messages }), null);
  });

  it('extracts label IDs from gog gmail get shapes', () => {
    assert.deepEqual(extractGogLabelIds({ labelIds: ['INBOX'] }), ['INBOX']);
    assert.deepEqual(extractGogLabelIds({ message: { labelIds: ['UNREAD'] } }), ['UNREAD']);
    assert.deepEqual(extractGogLabelIds({ message: { payload: { labelIds: ['STARRED'] } } }), ['STARRED']);
    assert.equal(extractGogLabelIds({ message: {} }), null);
  });
});
