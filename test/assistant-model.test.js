import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeAssistantModelInput } from '../src/assistant-model.js';

describe('assistant model context', () => {
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
});
