import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildClassificationPrompt, normalizeClassificationResult, SYSTEM_PROMPT } from '../src/classify.js';
import { formatRulesForPrompt } from '../src/rules.js';

describe('classification prompt', () => {
  it('labels the newest reply as primary and quoted history as background only', () => {
    const prompt = buildClassificationPrompt({
      from: 'Customer <customer@example.com>',
      to: 'Support <support@example.com>',
      subject: 'Re: Annual renewal',
      date: 'Mon, 13 Jul 2026 09:00:00 -0700',
      snippet: 'Please cancel it.',
      body: `Please cancel it.

On Mon, Jul 13, 2026 at 8:00 AM Support <support@example.com> wrote:
> The annual plan will renew for $1,200 on August 1.`,
    }, 'Keep customer replies.');

    assert.match(prompt, /Newest authored content \(PRIMARY\): Please cancel it\./);
    assert.match(prompt, /Earlier thread context \(BACKGROUND ONLY\):/);
    assert.match(prompt, /annual plan will renew for \$1,200/);
    assert.ok(prompt.indexOf('Please cancel it.') < prompt.indexOf('annual plan will renew'));
  });

  it('instructs the model not to substitute quoted history for the new reply', () => {
    assert.match(SYSTEM_PROMPT, /Classify and summarize what that newest content says/);
    assert.match(SYSTEM_PROMPT, /Never describe an earlier request, offer, or sent message as though it were the new reply/);
    assert.match(SYSTEM_PROMPT, /Do not replace it with a summary of the longer quoted message/);
  });

  it('bounds earlier thread context before sending it to the model', () => {
    const prompt = buildClassificationPrompt({
      from: 'Customer <customer@example.com>',
      subject: 'Re: Long thread',
      date: 'Mon, 13 Jul 2026 09:00:00 -0700',
      body: `Yes, approved.

On Mon, Jul 13, 2026 at 8:00 AM Support <support@example.com> wrote:
> ${'old context '.repeat(500)}`,
    }, 'Keep customer replies.');

    assert.match(prompt, /Earlier thread context \(BACKGROUND ONLY\):/);
    assert.match(prompt, /\[truncated\]/);
    assert.ok(prompt.length < 3000);
  });

  it('includes semantic rule IDs and accepts only effect-consistent model citations', () => {
    const rules = [{
      id: 'routine-receipts', match: 'Routine receipts', archive: true,
      source: 'assistant', description: 'Routine receipts', scope: 'user', editable: true,
    }];
    assert.match(formatRulesForPrompt(rules), /\[rule:routine-receipts\]/);

    const valid = normalizeClassificationResult({
      archive: true, confidence: 92, reason: 'Routine receipt', summary: 'Receipt',
      matchedRuleId: 'routine-receipts',
    }, { subject: 'Receipt', snippet: '' }, rules);
    assert.equal(valid.decisionBasis, 'semantic_rule');
    assert.equal(valid.appliedRule.id, 'routine-receipts');
    assert.equal(valid.appliedRule.attribution, 'model_cited');

    const wrongEffect = normalizeClassificationResult({
      archive: false, confidence: 92, reason: 'Keep', summary: 'Receipt',
      matchedRuleId: 'routine-receipts',
    }, { subject: 'Receipt', snippet: '' }, rules);
    assert.equal(wrongEffect.decisionBasis, 'classifier');
    assert.equal(wrongEffect.appliedRule, undefined);

    const unknown = normalizeClassificationResult({
      archive: true, confidence: 92, reason: 'Archive', summary: 'Receipt',
      matchedRuleId: 'invented-rule',
    }, { subject: 'Receipt', snippet: '' }, rules);
    assert.equal(unknown.decisionBasis, 'classifier');
    assert.equal(unknown.appliedRule, undefined);

    const safetyOverride = normalizeClassificationResult({
      archive: true, confidence: 60, reason: 'Maybe a receipt', summary: 'Receipt',
      matchedRuleId: 'routine-receipts',
    }, { subject: 'Receipt', snippet: '' }, rules);
    assert.equal(safetyOverride.archive, false);
    assert.equal(safetyOverride.decisionBasis, 'classifier');
    assert.equal(safetyOverride.appliedRule, undefined);

    const operator = normalizeClassificationResult({
      archive: true, confidence: 95, reason: 'Server policy', summary: 'Automated notice',
      matchedRuleId: 'operator-policy',
    }, { subject: 'Notice', snippet: '' }, [{
      id: 'operator-policy', match: 'Automated notices', archive: true,
      source: 'operator', description: 'Server-managed notice policy', scope: 'server', editable: false,
    }]);
    assert.equal(operator.decisionBasis, 'server_automation');
    assert.equal(operator.appliedRule.editable, false);
    assert.equal(operator.appliedRule.attribution, 'model_cited');
  });
});
