import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessageContent } from '../src/message-content.js';

describe('message content normalization', () => {
  it('keeps a short Gmail reply separate from the quoted outbound message', () => {
    const result = normalizeMessageContent(`That sounds good. Please move forward with the annual plan.

Thanks,
Alex

On Mon, Jul 13, 2026 at 8:14 AM Support <support@example.com> wrote:
> Your account is ready. The annual plan costs $1,200 and begins August 1.
> Reply before July 20 if you would like us to activate it.`);

    assert.equal(result.latestContent, 'That sounds good. Please move forward with the annual plan.');
    assert.match(result.threadContext, /annual plan costs \$1,200/);
    assert.equal(result.hadQuotedContent, true);
    assert.equal(result.sourceFormat, 'plain');
  });

  it('recognizes a wrapped Apple Mail reply attribution', () => {
    const result = normalizeMessageContent(`No, please cancel it instead.

Sent from my iPhone

On Jul 13, 2026, at 9:42 AM, Morgan Example
<morgan@example.com> wrote:

The renewal will be processed tomorrow.`);

    assert.equal(result.latestContent, 'No, please cancel it instead.');
    assert.match(result.threadContext, /renewal will be processed tomorrow/);
  });

  it('recognizes an Outlook plain-text header block', () => {
    const result = normalizeMessageContent(`I can meet at 3:30 instead.

Best regards,
Taylor

From: Jordan Example <jordan@example.com>
Sent: Monday, July 13, 2026 9:15 AM
To: Taylor Example <taylor@example.com>
Subject: RE: Planning call

Can you meet at 2:00?`);

    assert.equal(result.latestContent, 'I can meet at 3:30 instead.');
    assert.match(result.threadContext, /Can you meet at 2:00/);
  });

  it('separates Gmail HTML quote and signature containers', () => {
    const result = normalizeMessageContent(`<div>Approved. Please send the final invoice.</div>
<div class="gmail_signature">Casey<br>Operations</div>
<div class="gmail_quote">
  <div>On Mon, Jul 13, 2026 at 9:00 AM Billing wrote:</div>
  <blockquote>The draft invoice is $808.00. Please approve it by Friday.</blockquote>
</div>`);

    assert.equal(result.latestContent, 'Approved. Please send the final invoice.');
    assert.match(result.threadContext, /draft invoice is \$808\.00/);
    assert.equal(result.sourceFormat, 'html');
  });

  it('separates Outlook HTML reply blocks', () => {
    const result = normalizeMessageContent(`<html><body>
<div>Use the new EIN ending in 42.</div>
<div id="divRplyFwdMsg"><hr id="stopSpelling">
<b>From:</b> Accountant &lt;accountant@example.com&gt;<br>
<b>Subject:</b> Tax filing<br>
The old EIN ending in 17 appears on the prior return.
</div></body></html>`);

    assert.equal(result.latestContent, 'Use the new EIN ending in 42.');
    assert.match(result.threadContext, /old EIN ending in 17/);
  });

  it('separates Apple Mail HTML cite blocks', () => {
    const result = normalizeMessageContent(`<div>Tomorrow morning works.</div>
<blockquote type="cite">
  <div>On Jul 13, 2026, at 8:00 AM, Pat wrote:</div>
  <div>Would this afternoon or tomorrow morning work?</div>
</blockquote>`);

    assert.equal(result.latestContent, 'Tomorrow morning works.');
    assert.match(result.threadContext, /this afternoon or tomorrow morning/);
  });

  it('preserves a legitimate HTML blockquote without a reply marker', () => {
    const result = normalizeMessageContent(`<div>Please review this customer quote:</div>
<blockquote>The support was excellent and fast.</blockquote>`);

    assert.match(result.latestContent, /support was excellent and fast/);
    assert.equal(result.threadContext, '');
  });

  it('preserves a forwarded message when there is no authored preface', () => {
    const body = `---------- Forwarded message ---------
From: Receipts <receipts@example.com>
Date: Mon, Jul 13, 2026
Subject: Purchase receipt
To: user@example.com

Your purchase total was $330.`;
    const result = normalizeMessageContent(body);

    assert.equal(result.latestContent, body);
    assert.equal(result.threadContext, '');
    assert.equal(result.hadQuotedContent, false);
  });

  it('does not discard an entire reply that consists only of a sign-off-like word', () => {
    const result = normalizeMessageContent(`Thanks,
Alex

On Mon, Jul 13, 2026 at 8:14 AM Support <support@example.com> wrote:
> The issue is fixed.`);

    assert.equal(result.latestContent, 'Thanks,\nAlex');
    assert.match(result.threadContext, /issue is fixed/);
  });

  it('uses the snippet as a fallback when the full body is absent', () => {
    const result = normalizeMessageContent('', { fallback: 'Please call me tomorrow morning.' });
    assert.equal(result.latestContent, 'Please call me tomorrow morning.');
  });
});
