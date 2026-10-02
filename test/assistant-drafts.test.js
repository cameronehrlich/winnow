import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAssistantDraft, normalizeMailRecipients, normalizeOutboundDraft } from '../src/assistant-drafts.js';

describe('shared assistant draft contract', () => {
  it('accepts exact named mailboxes, quoted commas and bare addresses', () => {
    assert.deepEqual(normalizeMailRecipients([
      'Leon Tsui <leon.tsui@okta.com>', '"Ehrlich, Riley" <RILEY@example.com>',
      'riley@example.com', ' cam+work@example.com ',
    ], 'to'), ['leon.tsui@okta.com', 'riley@example.com', 'cam+work@example.com']);
  });

  it('rejects ambiguous lists, trailing junk, control characters and malformed addresses', () => {
    for (const address of [
      'first@example.com, second@example.com', 'Name <first@example.com> trailing',
      'One <first@example.com> Two <second@example.com>', 'Name <not-an-email>',
      'first@example.com\r\nBcc: second@example.com', '\0first@example.com',
      'Name <first@example.com>; second@example.com', 'first@-example.com', '.first@example.com', 'first..last@example.com',
    ]) {
      assert.throws(() => normalizeMailRecipients([address], 'to'), { code: 'invalid_draft' });
    }
    assert.throws(() => normalizeMailRecipients(['ok@example.com', null], 'cc'), { code: 'invalid_draft' });
    assert.throws(() => normalizeMailRecipients(Array(21).fill('ok@example.com'), 'to'), { code: 'invalid_draft' });
  });

  it('deduplicates without adding or exposing a Bcc-only recipient and preserves exact text', () => {
    const body = '\nHi Leon,\n\nNo thanks.\n';
    assert.deepEqual(normalizeOutboundDraft({
      body, to: ['Leon <LEON@example.com>'], cc: ['leon@example.com', 'Copy <copy@example.com>'],
      bcc: ['copy@example.com', 'secret@example.com'], subject: 'Re: Hello',
    }, 'reply'), {
      body, to: ['leon@example.com'], cc: ['copy@example.com'], bcc: ['secret@example.com'], subject: 'Re: Hello',
    });
  });

  it('uses the same canonical recipients in model drafts and outbound tools', () => {
    const draft = normalizeAssistantDraft({ kind: 'reply', to: ['Leon <leon@example.com>'], body: 'Thanks.' });
    const outbound = normalizeOutboundDraft({ to: ['Leon <leon@example.com>'], body: 'Thanks.' }, 'reply');
    assert.deepEqual(draft.to, outbound.to);
    assert.equal(draft.validationError, null);
    assert.equal(normalizeAssistantDraft({ kind: 'reply', body: 'Thanks.', to: [] }).validationError, null);
    assert.match(normalizeAssistantDraft({ kind: 'forward', body: '', to: [] }).validationError, /To email address/);
  });

  it('keeps invalid drafts visible but cannot make them sendable through truncation or reload', () => {
    for (const input of [
      { kind: 'reply', body: 'x'.repeat(20001), to: ['ok@example.com'] },
      { kind: 'reply', body: 'Hi', to: [...Array(20).fill('ok@example.com'), 'invalid'] },
      { kind: 'reply', body: 'Hi', to: ['ok@example.com'], subject: 'Hello\r\nBcc: hidden@example.com' },
      { kind: 'reply', body: '', to: ['ok@example.com'] },
      { kind: 'forward', body: '', to: ['ok@example.com'], subject: 123 },
    ]) {
      const visible = normalizeAssistantDraft(input);
      assert.ok(visible.validationError);
      assert.equal(normalizeAssistantDraft(visible).validationError, visible.validationError);
    }
    assert.equal(normalizeAssistantDraft(null), null);
    assert.throws(() => normalizeOutboundDraft({ to: ['bad'] }, 'forward'), { code: 'invalid_draft' });
  });
});
