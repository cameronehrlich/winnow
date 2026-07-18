import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_SYSTEM_PROMPT,
  inlineAttachmentParts,
  serializeAssistantModelInput,
} from '../src/assistant-model.js';

describe('assistant model context', () => {
  it('requires rule deduplication and preview before a future-mail proposal', () => {
    assert.match(ASSISTANT_SYSTEM_PROMPT, /read that account's existing rules and preview the candidate/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /equivalent rule instead of creating a duplicate/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /meaningfully different intent separate/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /content- or meaning-based condition/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /preserve those qualifiers in a semantic rule/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /do not\s+broaden it into a sender or subject rule/i);
  });

  it('requires email-scoped questions to use their selected message before searching', () => {
    assert.match(ASSISTANT_SYSTEM_PROMPT, /contextualEmail already contains the selected email/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /Do not search the mailbox or fetch the same thread again/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /finalAnswerRequired is true, make no tool calls/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /use mail\.read_attachment only when contextualEmail lists/i);
  });

  it('keeps oversized context valid, bounded, and preserves tools and newest chat', () => {
    const input = {
      conversation: { scope: 'email', account: 'me@example.com' },
      chatMessages: Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user', text: `${index}:${'x'.repeat(4000)}`,
      })),
      contextualEmail: {
        reference: { messageId: 'm1', threadId: 't1' },
        metadata: { subject: 'Large thread' },
        messages: Array.from({ length: 20 }, (_, index) => ({
          messageId: `m${index}`, subject: `Message ${index}`, body: 'secret '.repeat(3000),
        })),
      },
      toolResults: [{ tool: 'mail.get_thread', result: { body: 'result '.repeat(5000) } }],
      availableTools: [{ name: 'mail.search', inputSchema: { type: 'object' } }],
    };

    const serialized = serializeAssistantModelInput(input);
    const parsed = JSON.parse(serialized);
    assert.ok(serialized.length <= 24_000);
    assert.equal(parsed.availableTools[0].name, 'mail.search');
    assert.match(parsed.chatMessages.at(-1).text, /^29:/);
    assert.equal(parsed.contextualEmail.trust, 'untrusted_email_data');
    assert.equal(parsed.toolResults[0].trust, 'untrusted_tool_data');
  });

  it('uses plain text and preserves useful content later in the focused email', () => {
    const padding = 'Rental market commentary. '.repeat(150);
    const input = {
      conversation: { scope: 'email', account: 'me@example.com' },
      chatMessages: [{ role: 'user', text: 'How much is the rent estimate now?' }],
      contextualEmail: {
        reference: { messageId: 'focused', threadId: 'thread-1' },
        metadata: { subject: 'Rental market update' },
        messages: [{
          messageId: 'focused',
          threadId: 'thread-1',
          subject: 'Rental market update',
          body: `<html><body><style>.hidden { color: red; }</style><p>${padding}</p><p>Rent Zestimate: <strong>$4,250 per month</strong></p></body></html>`,
          htmlBody: '<p>This display-only field must never reach the model.</p>',
        }],
      },
      availableTools: [],
    };

    const parsed = JSON.parse(serializeAssistantModelInput(input));
    const message = parsed.contextualEmail.messages[0];
    assert.equal(message.focused, true);
    assert.match(message.body, /Rent Zestimate: \$4,250 per month/);
    assert.doesNotMatch(message.body, /<html|<style|<strong/i);
    assert.equal(Object.hasOwn(message, 'htmlBody'), false);
  });

  it('keeps private attachment bytes out of JSON context and creates supported inline parts', () => {
    const input = {
      contextualEmail: {
        reference: { account: 'me@example.com', messageId: 'm1', threadId: 't1' },
        attachments: [{
          messageId: 'm0', attachmentId: 'a1', filename: 'invoice.pdf',
          mimeType: 'application/pdf', sizeBytes: 9,
        }],
      },
      toolResults: [{
        tool: 'mail.read_attachment',
        result: { attachment: { filename: 'invoice.pdf' }, contentLoaded: true },
        privateAttachments: [
          { mimeType: 'application/pdf', data: Buffer.from('%PDF-test') },
          { mimeType: 'image/jpeg', data: Buffer.from('jpeg-private') },
          { mimeType: 'image/svg+xml', data: Buffer.from('svg-private') },
        ],
      }],
      availableTools: [],
    };
    const serialized = serializeAssistantModelInput(input);
    assert.doesNotMatch(serialized, /JVBERS10ZXN0|PDF-test/);
    assert.deepEqual(inlineAttachmentParts(input), [
      { inlineData: { mimeType: 'application/pdf', data: Buffer.from('%PDF-test').toString('base64') } },
      { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('jpeg-private').toString('base64') } },
    ]);
  });

  it('passes four JPEGs in one request and enforces the aggregate byte budget', () => {
    const fourImages = [1, 2, 3, 4].map(index => ({
      mimeType: 'image/jpeg', data: Buffer.from(`jpeg-${index}`),
    }));
    assert.equal(inlineAttachmentParts({
      toolResults: [{ privateAttachments: fourImages }],
    }).length, 4);

    const tooLarge = Buffer.alloc(12 * 1024 * 1024);
    const parts = inlineAttachmentParts({ toolResults: [{ privateAttachments: [
      { mimeType: 'image/png', data: tooLarge },
      { mimeType: 'image/png', data: Buffer.from('does-not-fit') },
    ] }] });
    assert.equal(parts.length, 1);
  });
});
