import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_SYSTEM_PROMPT,
  GeminiAssistantModel,
  assistantFunctionDeclarations,
  inlineAttachmentParts,
  serializeAssistantModelInput,
} from '../src/assistant-model.js';
import { ASSISTANT_TOOL_DEFINITIONS } from '../src/assistant-tools.js';
import { reloadConfig } from '../src/config.js';

function modelResponse(parts, finishReason = 'STOP') {
  return { candidates: [{ finishReason, content: { role: 'model', parts } }] };
}

describe('assistant generation recovery', () => {
  let tempDir;
  let originalConfigPath;
  beforeEach(() => {
    originalConfigPath = process.env.WINNOW_CONFIG_PATH;
    tempDir = mkdtempSync(join(tmpdir(), 'winnow-model-recovery-'));
    process.env.WINNOW_CONFIG_PATH = join(tempDir, 'config.yaml');
    writeFileSync(process.env.WINNOW_CONFIG_PATH, 'model:\n  assistant_name: gemini-3.5-flash\n');
    reloadConfig();
  });
  afterEach(() => {
    if (originalConfigPath === undefined) delete process.env.WINNOW_CONFIG_PATH;
    else process.env.WINNOW_CONFIG_PATH = originalConfigPath;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses minimal thinking only for latency recovery without changing the request or permissions', async () => {
    const requests = [];
    const model = new GeminiAssistantModel({ models: {
      async generateContent(request) {
        requests.push(request);
        return modelResponse([{ text: 'Draft ready.' }]);
      },
    } });
    const input = {
      chatMessages: [{ role: 'user', text: 'Please draft a polite reply with all these details.' }],
      availableTools: ASSISTANT_TOOL_DEFINITIONS.slice(0, 2),
    };
    const controller = new AbortController();
    await model.respond(input, { signal: controller.signal });
    await model.respond(input, { signal: controller.signal, latencyRecovery: true });
    assert.equal(requests[0].config.thinkingConfig.thinkingLevel, 'LOW');
    assert.equal(requests[1].config.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.equal(requests[1].contents, requests[0].contents);
    assert.deepEqual(requests[1].config.tools, requests[0].config.tools);
    assert.equal(requests[0].config.responseSchema, undefined);
    assert.equal(requests[0].config.responseMimeType, undefined);
    assert.equal(requests[1].config.systemInstruction, ASSISTANT_SYSTEM_PROMPT);
    assert.equal(requests[1].config.abortSignal, controller.signal);
    assert.deepEqual(requests[1].config.httpOptions.retryOptions, { attempts: 1 });
  });

  it('does not request unsupported minimal thinking from a Pro model', async () => {
    writeFileSync(process.env.WINNOW_CONFIG_PATH, 'model:\n  assistant_name: gemini-3.1-pro-preview\n');
    reloadConfig();
    let request;
    const model = new GeminiAssistantModel({ models: {
      async generateContent(value) {
        request = value;
        return modelResponse([{ text: 'Answer' }]);
      },
    } });
    await model.respond({ availableTools: [] }, { latencyRecovery: true });
    assert.equal(request.config.thinkingConfig.thinkingLevel, 'LOW');
  });

  it('uses an independent configurable fallback with identical context, typed functions and security instructions', async () => {
    const requests = [];
    const model = new GeminiAssistantModel({ models: {
      async generateContent(request) {
        requests.push(request);
        return modelResponse([{ text: 'Draft ready.' }]);
      },
    } });
    const input = { chatMessages: [{ role: 'user', text: 'Reply saying thanks.' }], availableTools: ASSISTANT_TOOL_DEFINITIONS };
    await model.respond(input);
    await model.respond(input, { useFallback: true });
    assert.equal(requests[0].model, 'gemini-3.5-flash');
    assert.equal(requests[1].model, 'gemini-3.1-flash-lite');
    assert.equal(requests[1].config.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.equal(requests[1].contents, requests[0].contents);
    assert.deepEqual(requests[1].config.tools, requests[0].config.tools);
    assert.equal(requests[1].config.systemInstruction, requests[0].config.systemInstruction);
    assert.equal(requests[1].config.maxOutputTokens, 8192);

    writeFileSync(process.env.WINNOW_CONFIG_PATH, 'model:\n  assistant_fallback_name: gemini-3.1-pro-preview\n');
    reloadConfig();
    await model.respond(input, { useFallback: true });
    assert.equal(requests[2].model, 'gemini-3.1-pro-preview');
    assert.equal(requests[2].config.thinkingConfig.thinkingLevel, 'LOW');
  });

  it('retains provider status and records safe metadata without email or attachment contents', async () => {
    const failure = new Error('provider unavailable');
    failure.status = 503;
    const model = new GeminiAssistantModel({ models: {
      async generateContent() { throw failure; },
    } });
    await assert.rejects(model.respond({
      chatMessages: [{ role: 'user', text: 'PRIVATE REQUEST' }],
      availableTools: [],
      toolResults: [{ tool: 'mail.read_attachment', privateAttachments: [{
        mimeType: 'application/pdf', data: Buffer.from('PRIVATE PDF'),
      }] }],
    }, { latencyRecovery: true }), error => {
      assert.equal(error, failure);
      assert.equal(error.status, 503);
      assert.equal(error.diagnostic.modelName, 'gemini-3.5-flash');
      assert.equal(error.diagnostic.latencyRecovery, true);
      assert.equal(error.diagnostic.attachmentCount, 1);
      assert.equal(error.diagnostic.attachmentBytes, 11);
      assert.ok(error.diagnostic.inputCharacters > 0);
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /PRIVATE|UFJJVkFUR/);
      return true;
    });
  });

  it('returns plain answers without exposing thought parts or decoding a JSON envelope', async () => {
    const model = new GeminiAssistantModel({ models: {
      async generateContent() {
        return modelResponse([
          { thought: true, text: 'PRIVATE reasoning', functionCall: { name: 'mail_archive', args: {} } },
          { text: 'The invoice is **$42**.' },
          { text: 'Payment is due Friday.' },
        ]);
      },
    } });
    assert.deepEqual(await model.respond({ availableTools: [] }), {
      text: 'The invoice is **$42**.\nPayment is due Friday.', toolCalls: [], draft: null,
    });
  });

  it('maps native calls back to canonical tools without executing them or discarding arguments', async () => {
    const args = { query: 'from:dentist after:2026/09/01', limit: 5 };
    const model = new GeminiAssistantModel({ models: {
      async generateContent() {
        return modelResponse([{ functionCall: { name: 'mail_search', args, id: 'call_1' } }]);
      },
    } });
    assert.deepEqual(await model.respond({ availableTools: ASSISTANT_TOOL_DEFINITIONS.slice(0, 1) }), {
      text: '', toolCalls: [{ name: 'mail.search', arguments: args }], draft: null,
    });
  });

  it('returns complete editable drafts even during tool-free final synthesis', async () => {
    const draft = {
      kind: 'reply', to: ['sender@example.com'], cc: [], bcc: [], subject: 'Re: Question', body: 'Thanks!',
    };
    const model = new GeminiAssistantModel({ models: {
      async generateContent() {
        return modelResponse([{ functionCall: { name: 'assistant_prepare_draft', args: draft } }]);
      },
    } });
    assert.deepEqual(await model.respond({ availableTools: [], conversation: { finalAnswerRequired: true } }), {
      text: 'Here’s your draft.', toolCalls: [], draft,
    });
  });

  it('preserves the existing draft and latest revision request in the native model context', async () => {
    const original = {
      kind: 'reply', to: ['sender@example.com'], cc: [], bcc: [], subject: 'Re: Opportunity', body: 'Not ready to consider that.',
    };
    const revised = { ...original, body: 'Thank you for your help. I’m not ready to consider that, but please keep me in mind.' };
    const model = new GeminiAssistantModel({ models: {
      async generateContent(request) {
        const context = JSON.parse(request.contents);
        assert.deepEqual(context.chatMessages[1].draft, original);
        assert.equal(context.chatMessages.at(-1).text, 'Can you make it more cordial and friendly and grateful.');
        assert.equal(request.config.responseSchema, undefined);
        return modelResponse([{ functionCall: { name: 'assistant_prepare_draft', args: revised } }]);
      },
    } });
    const result = await model.respond({
      availableTools: [],
      chatMessages: [
        { role: 'user', text: 'Reply that I am not ready to consider that.' },
        { role: 'assistant', text: 'Draft ready.', draft: original },
        { role: 'user', text: 'Can you make it more cordial and friendly and grateful.' },
      ],
    });
    assert.deepEqual(result.draft, revised);
    assert.deepEqual(result.toolCalls, []);
  });

  it('preserves compound draft and action outputs for existing server authorization', async () => {
    const draft = { kind: 'forward', to: ['person@example.com'], cc: [], bcc: [], subject: 'Fwd: Question', body: 'FYI' };
    const model = new GeminiAssistantModel({ models: {
      async generateContent() {
        return modelResponse([
          { text: 'Draft ready.' },
          { functionCall: { name: 'assistant_prepare_draft', args: draft } },
          { functionCall: { name: 'mail_archive', args: { account: 'me@example.com', threadId: 't1' } } },
        ]);
      },
    } });
    const result = await model.respond({ availableTools: ASSISTANT_TOOL_DEFINITIONS });
    assert.equal(result.text, 'Draft ready.');
    assert.deepEqual(result.draft, draft);
    assert.equal(result.toolCalls[0].name, 'mail.archive');
  });

  it('rejects malformed, unavailable, excessive and partial calls before any tool can run', async () => {
    const draft = { kind: 'reply', to: ['person@example.com'], cc: [], bcc: [], subject: 'Re: Question', body: 'Thanks' };
    const call = { functionCall: { name: 'mail_search', args: { query: 'from:dentist' } } };
    const invalid = [
      modelResponse([call, { functionCall: { name: 'mail_send_reply', args: {} } }]),
      modelResponse([{ functionCall: { name: 'made_up_tool', args: {} } }]),
      modelResponse([{ functionCall: { name: 'mail.search', args: {} } }]),
      modelResponse([{ functionCall: { name: 'mail_search', args: [] } }]),
      modelResponse([{ functionCall: { name: 'mail_search', args: null } }]),
      modelResponse([{ functionCall: { name: 'mail_search', args: { query: 'x'.repeat(12_001) } } }]),
      modelResponse(Array(4).fill(call)),
      modelResponse(Array(2).fill({ functionCall: { name: 'assistant_prepare_draft', args: draft } })),
      modelResponse([{ functionCall: { name: 'assistant_prepare_draft', args: { ...draft, body: null } } }]),
      modelResponse([{ functionCall: { name: 'assistant_prepare_draft', args: { ...draft, to: 'person@example.com' } } }]),
      modelResponse([{ functionCall: { name: 'assistant_prepare_draft', args: { ...draft, type: 'reply' } } }]),
      modelResponse([call], 'MAX_TOKENS'),
      modelResponse([{ text: 'Unsafe partial answer' }], 'SAFETY'),
    ];
    for (const response of invalid) {
      const model = new GeminiAssistantModel({ models: { async generateContent() { return response; } } });
      await assert.rejects(model.respond({ availableTools: ASSISTANT_TOOL_DEFINITIONS.slice(0, 1) }), error => {
        assert.equal(error.code, 'assistant_model_invalid_response');
        assert.doesNotMatch(JSON.stringify(error.diagnostic), /dentist|person@example/);
        return true;
      });
    }
    const unavailable = new GeminiAssistantModel({ models: { async generateContent() { return modelResponse([call]); } } });
    await assert.rejects(unavailable.respond({ availableTools: [] }), { code: 'assistant_model_invalid_response' });
  });

  it('treats empty or thought-only responses as recoverable rather than displaying them', async () => {
    for (const response of [null, {}, modelResponse([]), modelResponse([{ thought: true, text: 'Private thought' }])]) {
      const model = new GeminiAssistantModel({ models: { async generateContent() { return response; } } });
      await assert.rejects(model.respond({ availableTools: [] }), { code: 'assistant_model_empty_response' });
    }
  });
});

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
    assert.match(ASSISTANT_SYSTEM_PROMPT, /finalAnswerRequired is true, make no action-tool calls/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /use mail\.read_attachment only when contextualEmail lists/i);
  });

  it('treats reply-writing language as a draft rather than a send request', () => {
    assert.match(ASSISTANT_SYSTEM_PROMPT, /reply saying/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /editable draft, not a send proposal/i);
    assert.match(ASSISTANT_SYSTEM_PROMPT, /assistant_prepare_draft with no mail\.send_reply tool call/i);
  });

  it('builds typed native declarations from only the currently available tools', () => {
    const functions = assistantFunctionDeclarations([
      {
        name: 'mail.search',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer' },
          },
        },
      },
      {
        name: 'device.create_reminder',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            dueAt: { type: 'string' },
          },
        },
      },
    ]);

    assert.deepEqual(
      functions.map(call => call.name),
      ['mail_search', 'device_create_reminder', 'assistant_prepare_draft'],
    );
    assert.deepEqual(
      Object.keys(functions[0].parameters.properties).sort(),
      ['limit', 'query'],
    );
    assert.equal(functions[0].parameters.properties.limit.type, 'INTEGER');
    assert.match(functions[0].description, /^mail.search:/);
    assert.deepEqual(
      functions.at(-1).parameters.required,
      ['kind', 'to', 'cc', 'bcc', 'subject', 'body'],
    );
  });

  it('exposes only the internal draft formatter during final synthesis', () => {
    const functions = assistantFunctionDeclarations([]);
    assert.deepEqual(functions.map(call => call.name), ['assistant_prepare_draft']);
    assert.match(functions[0].description, /Does not send mail or authorize sending/);
  });

  it('represents every registered assistant tool without schema conflicts', () => {
    const functions = assistantFunctionDeclarations(ASSISTANT_TOOL_DEFINITIONS);
    assert.equal(functions.length, ASSISTANT_TOOL_DEFINITIONS.length + 1);
    const contact = functions.find(call => call.name === 'device_pick_contact');
    assert.deepEqual(contact.parameters.required, ['name', 'action']);
    assert.deepEqual(contact.parameters.properties.action.enum, ['forward']);
    assert.equal(contact.parameters.properties.type, undefined);
    const forward = functions.find(call => call.name === 'mail_send_forward');
    assert.deepEqual(forward.parameters.properties.draft.required, ['to']);
    assert.equal(forward.parameters.properties.draft.properties.body, undefined);
    assert.equal(forward.parameters.properties.draft.properties.skipAttachments.type, 'BOOLEAN');
  });

  it('rejects alias collisions and malformed function definitions instead of widening permissions', () => {
    const tool = { name: 'mail.search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
    for (const tools of [
      [tool, { ...tool, name: 'mail_search' }],
      [{ ...tool, name: 'assistant_prepare_draft' }],
      [{ ...tool, name: 'bad-name!' }],
      [{ name: 'mail.search' }],
    ]) {
      assert.throws(() => assistantFunctionDeclarations(tools), { code: 'assistant_tool_definition_invalid' });
    }
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

  it('keeps search hits structured with complete Gmail references and an explicit truncation marker', () => {
    const messages = Array.from({ length: 25 }, (_, index) => ({
      account: 'me@example.com', messageId: `message-${index}`, threadId: `thread-${index}`,
      subject: 'Dental X-ray request', from: 'Principal', date: '2026-09-15', snippet: 'x'.repeat(500),
    }));
    const input = JSON.parse(serializeAssistantModelInput({
      conversation: { scope: 'mailbox' }, chatMessages: [], availableTools: [],
      toolResults: [{ tool: 'mail.search', result: { messages } }],
    }));
    const result = input.toolResults[0].result;
    assert.ok(result.messages.length > 1);
    assert.ok(result.messages.length < 25);
    assert.equal(result.truncated, true);
    assert.equal(result.returnedCount, 25);
    assert.equal(result.preview, undefined);
    assert.equal(result.messages[1].threadId, 'thread-1');
  });

  it('compacts attachment-heavy threads without losing the focused message or tool model', () => {
    const focusedMessageId = 'focused';
    const input = {
      conversation: { scope: 'email', account: 'me@example.com' },
      chatMessages: [{ role: 'user', text: 'Can you write a polite reply about the data?' }],
      contextualEmail: {
        reference: { messageId: focusedMessageId, threadId: 'large-thread' },
        metadata: { subject: 'Attachment-heavy thread' },
        attachments: Array.from({ length: 27 }, (_, index) => ({
          messageId: index === 0 ? focusedMessageId : `message-${index % 8}`,
          attachmentId: `${index}-`.padEnd(426, 'a'),
          filename: `attachment-${index}.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 1_000,
        })),
        messages: Array.from({ length: 8 }, (_, index) => ({
          messageId: index === 0 ? focusedMessageId : `message-${index}`,
          subject: `Message ${index}`,
          body: 'Thread content. '.repeat(1_000),
        })),
      },
      toolResults: [],
      availableTools: ASSISTANT_TOOL_DEFINITIONS,
    };

    const serialized = serializeAssistantModelInput(input);
    const parsed = JSON.parse(serialized);
    assert.ok(serialized.length <= 24_000);
    assert.equal(parsed.availableTools.length, ASSISTANT_TOOL_DEFINITIONS.length);
    assert.equal(parsed.chatMessages.at(-1).text, input.chatMessages[0].text);
    assert.ok(parsed.contextualEmail.messages.some(message => message.focused));
    assert.ok(parsed.contextualEmail.attachments.some(
      attachment => attachment.messageId === focusedMessageId,
    ));
    assert.equal(parsed.contextualEmail.attachmentsTruncated, true);
    assert.ok(parsed.contextualEmail.attachments.length < input.contextualEmail.attachments.length);
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
