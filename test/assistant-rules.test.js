import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findMatchingAssistantRule,
  matchAssistantRule,
  validateAssistantRule,
} from '../src/assistant-rules.js';

const baseRule = {
  id: 'rule-1',
  account: 'Me@Example.com',
  effect: 'archive',
  matcherKind: 'sender',
  matcherValue: 'News@Example.org',
  enabled: true,
};

describe('assistant runtime rules', () => {
  it('normalizes and matches exact sender rules', () => {
    const normalized = validateAssistantRule(baseRule);
    assert.equal(normalized.account, 'me@example.com');
    assert.equal(normalized.matcherValue, 'news@example.org');
    assert.equal(matchAssistantRule(baseRule, {
      account: 'me@example.com',
      from: 'Example News <news@example.org>',
    }), true);
  });

  it('matches domains exactly rather than silently including subdomains', () => {
    const rule = { ...baseRule, matcherKind: 'domain', matcherValue: '@example.org' };
    assert.equal(matchAssistantRule(rule, { from: 'a@example.org' }), true);
    assert.equal(matchAssistantRule(rule, { from: 'a@news.example.org' }), false);
  });

  it('matches normalized List-ID headers', () => {
    const rule = { ...baseRule, matcherKind: 'list-id', matcherValue: '<updates.example.org>' };
    assert.equal(matchAssistantRule(rule, {
      headers: [{ name: 'List-ID', value: 'Product updates <updates.example.org>' }],
    }), true);
  });

  it('does not match disabled or wrong-account rules', () => {
    assert.equal(matchAssistantRule({ ...baseRule, enabled: false }, { from: 'news@example.org' }), false);
    assert.equal(matchAssistantRule(baseRule, {
      account: 'other@example.com',
      from: 'news@example.org',
    }), false);
  });

  it('rejects shell-capable legacy rule fields', () => {
    for (const unsafe of [
      { action: 'rm -rf /' },
      { trigger: ['invoice'] },
      { always: true },
      { command: 'script.sh' },
      { ACTION: 'script.sh' },
    ]) {
      assert.throws(() => validateAssistantRule({ ...baseRule, ...unsafe }), /cannot contain/);
    }
  });

  it('returns the first deterministic match in caller-defined order', () => {
    const keep = { ...baseRule, id: 'keep', effect: 'keep' };
    const archive = { ...baseRule, id: 'archive', effect: 'archive' };
    assert.equal(findMatchingAssistantRule([keep, archive], { from: 'news@example.org' }).id, 'keep');
    assert.equal(findMatchingAssistantRule([keep], { from: 'other@example.org' }), null);
  });
});
