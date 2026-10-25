import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { reloadConfig } from '../src/config.js';
import {
  configureDatabaseForTests, closeStoreForTests, addAssistantMessage, createAssistantConversation,
  upsertEmailItemFromResult, getAssistantMessage,
  claimGmailDraftOperation, finishGmailDraftOperation,
} from '../src/store.js';
import {
  getMailDraft, listMailDrafts, updateMailDraft, createMailDraft, sendMailDraft, mailDraftAttachment,
} from '../src/mail-drafts.js';
import { createApiServer } from '../src/api.js';
import { proposeAssistantDraftSend, submitAssistantMessage, setAssistantDependenciesFactoryForTests, resetAssistantDependenciesFactoryForTests } from '../src/assistant.js';
import { setAssistantModelFactoryForTests, resetAssistantModelFactoryForTests } from '../src/assistant-model.js';

function draft(id = 'r-1', { account = 'me@example.com', body = 'Hello', to = 'friend@example.com', cc = '', bcc = '', html = false, attachments = [], reply = false } = {}) {
  return { id, message: { id: `m-${id}`, threadId: 'thread-1', internalDate: '1790000000000', labelIds: ['DRAFT'], snippet: body,
    payload: { mimeType: html ? 'text/html' : 'text/plain', headers: [
      { name: 'From', value: account }, { name: 'To', value: to }, { name: 'Cc', value: cc },
      { name: 'Bcc', value: bcc }, { name: 'Subject', value: 'Subject' },
      ...(reply ? [{ name: 'In-Reply-To', value: '<original@example.com>' }] : []),
    ], body: { data: Buffer.from(body).toString('base64url') }, parts: attachments },
  } };
}

describe('Gmail draft lifecycle', () => {
  let dir, originalConfig, adapter, records, calls, options;
  beforeEach(() => {
    originalConfig = process.env.WINNOW_CONFIG_PATH;
    dir = mkdtempSync(join(tmpdir(), 'winnow-drafts-'));
    process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
    process.env.WINNOW_CONFIG_PATH = join(dir, 'config.yaml');
    writeFileSync(process.env.WINNOW_CONFIG_PATH, 'accounts:\n  - email: me@example.com\n  - email: other@example.com\n  - email: retired@example.com\n    read_only: true\n');
    reloadConfig(); configureDatabaseForTests(join(dir, 'test.db'));
    claimGmailDraftOperation({ key: 'fixture-origin', kind: 'create', account: 'me@example.com', targetId: 'fixture-origin', digest: 'fixture' });
    finishGmailDraftOperation('fixture-origin', 'succeeded', { draftId: 'r-1', replyMessageId: 'original-1', threadId: 'thread-1', replyHeaders: { 'in-reply-to': '<original@example.com>', references: '' } });
    records = new Map([['me@example.com:r-1', draft('r-1', { reply: true })]]);
    calls = { sends: 0, saves: 0, reads: 0 };
    adapter = {
      async listDrafts(account) { return { drafts: [...records].filter(([key]) => key.startsWith(account + ':')).map(([, value]) => ({ id: value.id })), nextPageToken: '' }; },
      async getDraft(account, id) { calls.reads++; const value = records.get(account + ':' + id); if (!value) throw new Error('404 notFound'); return structuredClone(value); },
      async listSendAs(account) { return [{ sendAsEmail: account, isPrimary: true }]; },
      async saveDraft(account, fields, { draftId = '', replyMessageId = '' } = {}) {
        calls.saves++; const id = draftId || 'r-new';
        records.set(account + ':' + id, draft(id, { account: fields.from, body: fields.body, to: fields.to.join(','), cc: fields.cc.join(','), bcc: fields.bcc.join(','), reply: Boolean(replyMessageId) }));
        calls.replyMessageId = replyMessageId;
        return { draftId: id };
      },
      async sendDraft(account, id) { calls.sends++; records.delete(account + ':' + id); return { messageId: 'sent-1', threadId: 'thread-1' }; },
      async getMessage() { return { id: 'original-1', from: 'friend@example.com', to: 'me@example.com' }; },
      async getAttachment() { return Buffer.from('PDF'); },
    };
    options = { adapter };
  });
  afterEach(() => {
    resetAssistantModelFactoryForTests();
    resetAssistantDependenciesFactoryForTests();
    closeStoreForTests();
    if (originalConfig === undefined) delete process.env.WINNOW_CONFIG_PATH; else process.env.WINNOW_CONFIG_PATH = originalConfig;
    reloadConfig(); rmSync(dir, { recursive: true, force: true });
  });
  const ref = { account: 'me@example.com', draftId: 'r-1' };
  const fields = { from: 'me@example.com', to: ['friend@example.com'], cc: [], bcc: [], subject: 'Updated', body: 'Updated body' };

  it('keys rows by stable draft IDs, reads exact recipients and detects message replacement', async () => {
    records.set('me@example.com:r-1', draft('r-1', { cc: 'cc@example.com', bcc: 'private@example.com', reply: true }));
    const first = await getMailDraft(ref, options);
    assert.equal(first.draftId, 'r-1'); assert.equal(first.bcc, 'private@example.com'); assert.equal(first.editable, true);
    records.get('me@example.com:r-1').message.id = 'replacement-message';
    const second = await getMailDraft(ref, options);
    assert.equal(second.draftId, first.draftId); assert.notEqual(second.revision, first.revision);
    assert.doesNotMatch(first.revision, /Hello|friend/);
  });

  it('paginates accounts independently and skips drafts sent during listing', async () => {
    const requested = [];
    adapter.listDrafts = async (account, { pageToken }) => {
      requested.push([account, pageToken]);
      return account === ref.account ? { drafts: [{ id: pageToken ? 'r-1' : 'gone' }], nextPageToken: pageToken ? '' : 'next-1' } : { drafts: [], nextPageToken: '' };
    };
    const first = await listMailDrafts({ accounts: ['other@example.com', ref.account] }, options);
    assert.deepEqual(first.items, []); assert.ok(first.nextCursor);
    const second = await listMailDrafts({ accounts: [ref.account, 'other@example.com'], cursor: first.nextCursor }, options);
    assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
    assert.equal(requested.filter(([a]) => a === 'other@example.com').length, 1);
    await assert.rejects(listMailDrafts({ accounts: [ref.account], cursor: first.nextCursor }, options), { code: 'invalid_cursor' });
  });

  it('reports unavailable accounts without claiming the partial list is complete', async () => {
    const list = adapter.listDrafts;
    adapter.listDrafts = async account => { if (account === 'other@example.com') throw new Error('offline'); return list(account); };
    const response = await listMailDrafts({ accounts: [ref.account, 'other@example.com'] }, options);
    assert.equal(response.items.length, 1); assert.deepEqual(response.unavailableAccounts, ['other@example.com']);
    await assert.rejects(listMailDrafts({ accounts: ['other@example.com'] }, options), { code: 'drafts_unavailable' });
  });

  it('rejects inactive accounts, malformed IDs, fields, and stale revisions before writes', async () => {
    await assert.rejects(getMailDraft({ ...ref, account: 'retired@example.com' }, options), { code: 'invalid_account' });
    await assert.rejects(getMailDraft({ ...ref, draftId: '--danger' }, options), { code: 'invalid_draft_request' });
    await assert.rejects(updateMailDraft({ ...ref, revision: 'old', fields }, options), { code: 'draft_changed' });
    const current = await getMailDraft(ref, options);
    await assert.rejects(updateMailDraft({ ...ref, revision: current.revision, fields: { ...fields, bcc: ['bad address'] } }, options), { code: 'invalid_draft' });
    assert.equal(calls.saves, 0); assert.equal(calls.sends, 0);
  });

  it('edits plain drafts and clears recipients without silently dropping rich MIME', async () => {
    const current = await getMailDraft(ref, options);
    const updated = await updateMailDraft({ ...ref, revision: current.revision, fields: { ...fields, to: [], bcc: ['secret@example.com'] } }, options);
    assert.equal(updated.to, ''); assert.equal(updated.bcc, 'secret@example.com'); assert.equal(updated.body, fields.body);
    records.set('me@example.com:r-1', draft('r-1', { html: true, body: '<b>Rich text</b>' }));
    const rich = await getMailDraft(ref, options);
    assert.equal(rich.editable, false);
    await assert.rejects(updateMailDraft({ ...ref, revision: rich.revision, fields }, options), { code: 'draft_edit_in_gmail' });
    records.set('me@example.com:r-unknown', draft('r-unknown', { reply: true }));
    assert.equal((await getMailDraft({ ...ref, draftId: 'r-unknown' }, options)).editable, false);
    const changed = records.get('me@example.com:r-1');
    changed.message.payload.headers.push({ name: 'In-Reply-To', value: '<changed-elsewhere@example.com>' });
    assert.equal((await getMailDraft(ref, options)).editable, false);
    assert.equal(calls.saves, 1);
  });

  it('sends the exact Gmail draft once, preserving rich content and Bcc on retries', async () => {
    records.set('me@example.com:r-1', draft('r-1', { html: true, body: '<b>Rich</b>', to: '', bcc: 'private@example.com' }));
    const current = await getMailDraft(ref, options);
    const request = { ...ref, revision: current.revision, idempotencyKey: 'send-1', confirmed: true };
    await assert.rejects(sendMailDraft({ ...request, confirmed: false }, options), { code: 'draft_confirmation_required' });
    await assert.rejects(sendMailDraft({ ...request, revision: null }, options), { code: 'invalid_revision' });
    await assert.rejects(sendMailDraft({ ...request, revision: 'stale' }, options), { code: 'draft_changed' });
    const sent = await sendMailDraft(request, options);
    assert.deepEqual(await sendMailDraft({ ...request, idempotencyKey: 'second-device' }, options), sent);
    assert.equal(calls.sends, 1); assert.equal(calls.saves, 0);
  });

  it('persists an uncertain send fence across restarts and never blindly resends', async () => {
    adapter.sendDraft = async () => { calls.sends++; throw new Error('connection lost after request'); };
    const current = await getMailDraft(ref, options);
    const request = { ...ref, revision: current.revision, idempotencyKey: 'uncertain', confirmed: true };
    await assert.rejects(sendMailDraft(request, options), { code: 'draft_send_unconfirmed' });
    closeStoreForTests(); configureDatabaseForTests(join(dir, 'test.db'));
    await assert.rejects(sendMailDraft({ ...request, idempotencyKey: 'new-device-key' }, options), { code: 'draft_operation_unconfirmed' });
    assert.equal(calls.sends, 1);
  });

  it('coalesces simultaneous sends from two devices before contacting Gmail twice', async () => {
    const current = await getMailDraft(ref, options);
    let release;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    adapter.sendDraft = async () => { calls.sends++; began(); await new Promise(resolve => { release = resolve; }); return { messageId: 'sent-1', threadId: 't1' }; };
    const request = { ...ref, revision: current.revision, idempotencyKey: 'device-1', confirmed: true };
    const first = sendMailDraft(request, options);
    await started;
    await assert.rejects(sendMailDraft({ ...request, idempotencyKey: 'device-2' }, options), { code: 'draft_operation_unconfirmed' });
    release(); await first;
    assert.equal(calls.sends, 1);
  });

  it('does not repeat an unconfirmed create with a new request key', async () => {
    adapter.saveDraft = async () => { calls.saves++; throw new Error('connection lost after create'); };
    await assert.rejects(createMailDraft({ account: ref.account, fields, idempotencyKey: 'create-unknown' }, options), { code: 'draft_operation_unconfirmed' });
    await assert.rejects(createMailDraft({ account: ref.account, fields, idempotencyKey: 'create-unknown' }, options), { code: 'draft_operation_unconfirmed' });
    assert.equal(calls.saves, 1);
  });

  it('requires a verified sender and at least one recipient', async () => {
    records.set('me@example.com:r-1', draft('r-1', { account: 'unverified@example.com' }));
    let current = await getMailDraft(ref, options);
    await assert.rejects(sendMailDraft({ ...ref, revision: current.revision, idempotencyKey: 'sender', confirmed: true }, options), { code: 'sender_not_verified' });
    records.set('me@example.com:r-1', draft('r-1', { to: '' }));
    current = await getMailDraft(ref, options);
    await assert.rejects(sendMailDraft({ ...ref, revision: current.revision, idempotencyKey: 'empty', confirmed: true }, options), { code: 'draft_recipient_required' });
    assert.equal(calls.sends, 0);
  });

  it('deduplicates new drafts and rejects reusing a key for different content', async () => {
    const request = { account: ref.account, fields, idempotencyKey: 'new-1' };
    const first = await createMailDraft(request, options);
    const second = await createMailDraft(request, options);
    assert.equal(first.draftId, second.draftId); assert.equal(calls.saves, 1);
    await assert.rejects(createMailDraft({ ...request, fields: { ...fields, body: 'different' } }, options), { code: 'draft_request_conflict' });
  });

  it('saves a canonical Winnow reply with exact account, alias and reply context, then links it', async () => {
    const item = upsertEmailItemFromResult({ account: ref.account, messageId: 'original-1', threadId: 'thread-1', from: 'friend@example.com', subject: 'Subject' }, { action: 'keep', summary: 'Summary' });
    const conversation = createAssistantConversation({ id: 'conv-1', scope: 'email', account: ref.account, emailItemId: item.id });
    addAssistantMessage({ id: 'draft-message', conversationId: conversation.id, role: 'assistant', draft: { kind: 'reply', ...fields } });
    const saved = await createMailDraft({ account: ref.account, sourceMessageId: 'draft-message', idempotencyKey: 'chat-save' }, options);
    assert.equal(calls.replyMessageId, 'original-1'); assert.equal(saved.editable, true);
    assert.equal(getAssistantMessage('draft-message').savedDraft.draftId, saved.draftId);
    await assert.rejects(proposeAssistantDraftSend(conversation.id, { messageId: 'draft-message', idempotencyKey: 'old-chat-send' }), { code: 'draft_saved_in_gmail' });
    let modelCalled = false;
    setAssistantModelFactoryForTests(() => ({ async respond() { modelCalled = true; throw new Error('Must not generate another send'); } }));
    const answer = await submitAssistantMessage(conversation.id, { text: 'Send this reply draft.', idempotencyKey: 'natural-chat-send' });
    assert.equal(modelCalled, false); assert.match(answer.messages.at(-1).text, /Open it from Drafts/);
    records.get(ref.account + ':' + saved.draftId).message.payload.body.data = Buffer.from('Edited elsewhere').toString('base64url');
    records.get(ref.account + ':' + saved.draftId).message.payload.headers.find(header => header.name === 'In-Reply-To').value = '<changed-elsewhere@example.com>';
    const reopened = await createMailDraft({ account: ref.account, sourceMessageId: 'draft-message', idempotencyKey: 'another-device' }, options);
    assert.equal(reopened.body, 'Edited elsewhere'); assert.equal(calls.saves, 1);
    assert.equal(reopened.editable, false);
    await assert.rejects(createMailDraft({ account: 'other@example.com', sourceMessageId: 'draft-message', idempotencyKey: 'wrong-account' }, options), { code: 'invalid_source_draft' });
  });

  it('only downloads attachments still belonging to the fresh draft', async () => {
    records.set('me@example.com:r-1', draft('r-1', { attachments: [{ mimeType: 'application/pdf', filename: 'doc.pdf', body: { attachmentId: 'att-1', size: 3 } }] }));
    assert.equal((await getMailDraft(ref, options)).editable, false);
    const result = await mailDraftAttachment({ ...ref, attachmentId: 'att-1' }, options);
    assert.equal(result.data.toString(), 'PDF');
    await assert.rejects(mailDraftAttachment({ ...ref, attachmentId: 'not-in-draft' }, options), { code: 'attachment_not_found' });
  });

  it('prevents Save Draft racing another device’s send or reviving an already sent chat copy', async () => {
    const item = upsertEmailItemFromResult({ account: ref.account, messageId: 'original-1', threadId: 'thread-1', from: 'friend@example.com', subject: 'Subject' }, { action: 'keep', summary: 'Summary' });
    const conversation = createAssistantConversation({ id: 'race-conversation', scope: 'email', account: ref.account, emailItemId: item.id });
    addAssistantMessage({ id: 'race-draft', conversationId: conversation.id, role: 'assistant', draft: { kind: 'reply', ...fields } });
    let release;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    setAssistantDependenciesFactoryForTests(() => ({
      getMessage: async () => { began(); return new Promise(resolve => { release = () => resolve({ id: 'original-1', from: 'friend@example.com', to: ref.account }); }); },
      listSendAs: async () => [{ sendAsEmail: ref.account, isPrimary: true }],
    }));
    const preparingSend = proposeAssistantDraftSend(conversation.id, { messageId: 'race-draft', idempotencyKey: 'prepare-send' });
    await started;
    try {
      await assert.rejects(createMailDraft({ account: ref.account, sourceMessageId: 'race-draft', idempotencyKey: 'race-save' }, options), { code: 'draft_send_pending' });
    } finally { release(); }
    const proposed = await preparingSend;
    const proposal = proposed.messages.at(-1).proposal;
    assert.equal(proposal.status, 'pending');
    const database = new DatabaseSync(join(dir, 'test.db'));
    database.prepare("UPDATE assistant_proposals SET status = 'completed' WHERE id = ?").run(proposal.id);
    database.close();
    await assert.rejects(createMailDraft({ account: ref.account, sourceMessageId: 'race-draft', idempotencyKey: 'save-sent-copy' }, options), { code: 'draft_send_pending' });
    assert.equal(calls.saves, 0); assert.equal(calls.sends, 0);
  });

  it('serves authenticated draft routes without permitting account or confirmation bypass', async () => {
    process.env.WINNOW_API_TOKEN = 'draft-fixture-token';
    const server = createApiServer({ mailDraftOptions: options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(base + '/v1/drafts')).status, 401);
      const headers = { Authorization: 'Bearer draft-fixture-token', 'Content-Type': 'application/json' };
      const list = await fetch(base + '/v1/drafts?account=me%40example.com', { headers });
      assert.equal(list.status, 200); assert.equal((await list.json()).items.length, 1);
      assert.equal((await fetch(base + '/v1/drafts/r-1?account=retired%40example.com', { headers })).status, 400);
      const send = await fetch(base + '/v1/drafts/r-1/send?account=me%40example.com', { method: 'POST', headers, body: JSON.stringify({ confirmed: false, revision: 'x', idempotencyKey: 'unsafe' }) });
      assert.equal(send.status, 400); assert.equal(calls.sends, 0);
    } finally { await new Promise(resolve => server.close(resolve)); delete process.env.WINNOW_API_TOKEN; }
  });
});
