import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildClassificationPrompt, SYSTEM_PROMPT } from '../src/classify.js';

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
});
