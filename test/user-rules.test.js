import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { reloadConfig } from '../src/config.js';
import { loadAllRules } from '../src/rules.js';
import { ruleRevision } from '../src/rule-revisions.js';
import {
  evaluateSemanticRulePreview,
  SemanticPreviewError,
} from '../src/semantic-rule-preview.js';
import {
  ASSISTANT_TOOL_DEFINITIONS,
  executeAssistantProposal,
  prepareAssistantTool,
} from '../src/assistant-tools.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  createAssistantConversation,
  createAssistantProposal,
  createAssistantRunWithUserMessage,
  finishAssistantRunWithProposal,
  getAssistantProposal,
  getUserRuleRecord,
  listEvents,
  listUserRuleRecords,
  upsertEmailItemFromResult,
} from '../src/store.js';
import {
  disableUserRule,
  importUserRules,
  listBaselineRules,
  listEffectiveExactRules,
  listEffectiveSemanticRules,
  listOperatorActionRules,
  listRulesForApi,
  planUserRuleImport,
  previewUserRule,
  resetUserRule,
  upsertUserRule,
} from '../src/user-rules.js';

let tempDir;
let databasePath;

beforeEach(() => {
  process.env.WINNOW_SKIP_LEGACY_IMPORT = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-user-rules-'));
  process.env.WINNOW_CONFIG_PATH = join(tempDir, 'config.yaml');
  process.env.WINNOW_RULES_DIR = join(tempDir, 'rules');
  writeFileSync(process.env.WINNOW_CONFIG_PATH, 'accounts:\n  - email: me@example.com\n', 'utf8');
  mkdirSync(process.env.WINNOW_RULES_DIR);
  writeFileSync(join(process.env.WINNOW_RULES_DIR, 'baseline-rules.yaml'), `
rules:
  - id: baseline-news
    match: Baseline newsletter guidance
    archive: true
`, 'utf8');
  writeFileSync(join(process.env.WINNOW_RULES_DIR, 'rules-me@example.com.yaml'), `
rules:
  - id: personal-projects
    match: Messages about personal projects
    archive: false
  - id: baseline-news
    match: Baseline newsletter guidance
    archive: false
  - id: operator-hook
    match: TestFlight removal requests
    archive: true
    trigger: [testflight, remove]
    action: /private/operator-script.sh
`, 'utf8');
  reloadConfig();
  databasePath = join(tempDir, 'winnow.db');
  configureDatabaseForTests(databasePath);
});

afterEach(() => {
  closeStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_SKIP_LEGACY_IMPORT;
  delete process.env.WINNOW_CONFIG_PATH;
  delete process.env.WINNOW_RULES_DIR;
});

describe('unified user rules', () => {
  it('dry-runs and imports ordinary YAML semantics while keeping hooks operator-only', () => {
    const before = loadAllRules('me@example.com').rules;
    assert.equal(before.find(rule => rule.id === 'baseline-news').archive, false);
    assert.ok(before.some(rule => rule.id === 'operator-hook'));

    const plan = planUserRuleImport('me@example.com');
    assert.equal(plan.dryRun, true);
    assert.equal(plan.candidates.length, 2);
    assert.equal(plan.operatorHookCount, 1);
    assert.equal(listUserRuleRecords({ account: 'me@example.com' }).length, 0);

    const applied = importUserRules('me@example.com', { dryRun: false });
    assert.equal(applied.imported.length, 2);
    assert.equal(listRulesForApi('me@example.com').migrationPending, false);
    assert.ok(!listRulesForApi('me@example.com').rules.some(rule => rule.id === 'operator-hook'));
    assert.doesNotMatch(JSON.stringify(listRulesForApi('me@example.com')), /operator-script|trigger|action/);
    assert.equal(listOperatorActionRules('me@example.com')[0].action, '/private/operator-script.sh');

    const after = loadAllRules('me@example.com').rules;
    assert.equal(after.find(rule => rule.match === 'Baseline newsletter guidance').archive, false);
    assert.ok(after.some(rule => rule.id === 'operator-hook'));
  });

  it('requires preview-bound consent before replacing an exact conflict', async () => {
    const first = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'archive',
      matcherKind: 'sender', matcherValue: 'Sender@Example.com',
    }, { source: 'assistant' });
    const candidate = {
      account: 'me@example.com', type: 'exact', effect: 'keep',
      matcherKind: 'sender', matcherValue: 'sender@example.com',
    };
    assert.throws(
      () => upsertUserRule(candidate, { source: 'api' }),
      error => error.code === 'rule_conflict_confirmation_required',
    );
    const preview = await previewUserRule(candidate);
    const replacement = upsertUserRule({
      ...candidate,
      expectedConflict: {
        ruleId: preview.conflict.rule.id,
        updatedAt: preview.conflict.rule.updatedAt,
      },
    }, { source: 'api' });
    assert.equal(replacement.id, first.id);
    assert.equal(replacement.effect, 'keep');
    assert.equal(listEffectiveExactRules('me@example.com').length, 1);
  });

  it('rejects stale or disappeared replacement bindings', async () => {
    const existing = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'archive',
      matcherKind: 'domain', matcherValue: 'example.com',
    });
    const candidate = {
      account: 'me@example.com', type: 'exact', effect: 'keep',
      matcherKind: 'domain', matcherValue: 'example.com',
    };
    const preview = await previewUserRule(candidate);
    assert.equal(preview.conflict.rule.id, existing.id);
    upsertUserRule({
      id: existing.id, account: existing.account, type: existing.type, effect: existing.effect,
      matcherKind: existing.matcherKind, matcherValue: existing.matcherValue,
      description: 'Changed after preview',
      expectedRule: { ruleId: existing.id, updatedAt: existing.updatedAt },
    });
    assert.throws(
      () => upsertUserRule({
        ...candidate,
        expectedConflict: {
          ruleId: preview.conflict.rule.id,
          updatedAt: preview.conflict.rule.updatedAt,
        },
      }),
      error => error.code === 'rule_conflict_changed',
    );
  });

  it('revision-binds existing rule edits and preserves identity across matcher changes', async () => {
    const existing = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'archive',
      matcherKind: 'sender', matcherValue: 'old@example.com', description: 'Old sender',
    });
    const candidate = {
      id: existing.id, account: existing.account, type: 'exact', effect: 'archive',
      matcherKind: 'sender', matcherValue: 'new@example.com', description: 'New sender',
    };
    const preview = await previewUserRule(candidate);
    assert.deepEqual(preview.expectedRule, {
      ruleId: existing.id,
      updatedAt: existing.updatedAt,
    });
    assert.throws(
      () => upsertUserRule(candidate),
      error => error.code === 'rule_revision_confirmation_required',
    );
    const saved = upsertUserRule({ ...candidate, expectedRule: preview.expectedRule });
    assert.equal(saved.id, existing.id);
    assert.equal(saved.matcherValue, 'new@example.com');
    assert.equal(getUserRuleRecord(existing.id).matcherValue, 'new@example.com');

    const typeCandidate = {
      id: saved.id, account: saved.account, type: 'semantic', effect: 'keep',
      match: 'Messages from the newly grouped sender', description: 'Semantic replacement',
    };
    const typePreview = await previewUserRule(typeCandidate);
    const changedType = upsertUserRule({
      ...typeCandidate,
      expectedRule: typePreview.expectedRule,
    });
    assert.equal(changedType.id, existing.id);
    assert.equal(changedType.type, 'semantic');
    assert.equal(changedType.match, typeCandidate.match);
    assert.equal(changedType.matcherKind, undefined);
  });

  it('atomically merges an existing rule into a separately confirmed conflict target', async () => {
    const edited = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'archive',
      matcherKind: 'sender', matcherValue: 'first@example.com', description: 'First',
    });
    const target = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'keep',
      matcherKind: 'sender', matcherValue: 'second@example.com', description: 'Second',
    });
    const candidate = {
      id: edited.id, account: edited.account, type: 'exact', effect: 'archive',
      matcherKind: 'sender', matcherValue: 'second@example.com', description: 'Merged',
    };
    const preview = await previewUserRule(candidate);
    assert.equal(preview.expectedRule.ruleId, edited.id);
    assert.equal(preview.conflict.rule.id, target.id);
    const saved = upsertUserRule({
      ...candidate,
      expectedRule: preview.expectedRule,
      expectedConflict: {
        ruleId: preview.conflict.rule.id,
        updatedAt: preview.conflict.rule.updatedAt,
      },
    });
    assert.equal(saved.id, edited.id);
    assert.equal(saved.matcherValue, 'second@example.com');
    assert.equal(getUserRuleRecord(target.id), null);
    assert.equal(listEffectiveExactRules('me@example.com').length, 1);
  });

  it('returns exact rules in newest-first precedence order', () => {
    const older = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'archive',
      matcherKind: 'domain', matcherValue: 'example.com',
    });
    const newer = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'keep',
      matcherKind: 'sender', matcherValue: 'person@example.com',
    });
    const database = new DatabaseSync(databasePath);
    database.prepare('UPDATE user_rules SET updated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', older.id);
    database.prepare('UPDATE user_rules SET updated_at = ? WHERE id = ?')
      .run('2026-02-01T00:00:00.000Z', newer.id);
    database.close();

    assert.deepEqual(listEffectiveExactRules('me@example.com').map(rule => rule.id), [newer.id, older.id]);
  });

  it('customizes a read-only baseline through an override and reset restores it', async () => {
    importUserRules('me@example.com', { dryRun: false });
    const candidate = {
      account: 'me@example.com', type: 'semantic', effect: 'keep',
      baselineRuleId: 'baseline-news',
    };
    const preview = await previewUserRule(candidate, {
      evaluator: async () => ({ model: 'test', evaluations: [] }),
    });
    const override = upsertUserRule({
      ...candidate,
      expectedConflict: {
        ruleId: preview.conflict.rule.id,
        updatedAt: preview.conflict.rule.updatedAt,
      },
    });
    assert.equal(override.match, 'Baseline newsletter guidance');
    assert.equal(listRulesForApi('me@example.com').rules.filter(rule => (
      rule.id === 'baseline-news' && rule.scope === 'baseline'
    )).length, 0);
    assert.equal(loadAllRules('me@example.com').rules.find(rule => rule.id === override.id).archive, false);

    assert.deepEqual(resetUserRule(override.id), {
      reset: true,
      restoredBaselineRuleId: 'baseline-news',
    });
    const restored = listRulesForApi('me@example.com').rules.find(rule => rule.id === 'baseline-news');
    assert.equal(restored.scope, 'baseline');
    assert.equal(restored.editable, false);
    assert.equal(loadAllRules('me@example.com').rules.find(rule => rule.id === 'baseline-news').archive, true);
  });

  it('requires reset instead of disabling a baseline customization', () => {
    const override = upsertUserRule({
      account: 'me@example.com', type: 'semantic', effect: 'keep',
      baselineRuleId: 'baseline-news',
    });
    assert.throws(
      () => disableUserRule(override.id),
      /baseline overrides cannot be disabled/i,
    );
    assert.throws(
      () => upsertUserRule({
        id: override.id, account: override.account, type: override.type,
        effect: override.effect, baselineRuleId: override.baselineRuleId, enabled: false,
        expectedRule: { ruleId: override.id, updatedAt: override.updatedAt },
      }),
      /baseline overrides cannot be disabled/i,
    );
    assert.equal(getUserRuleRecord(override.id).enabled, true);
  });

  it('keeps a customization attached to the current versioned baseline match', () => {
    const override = upsertUserRule({
      account: 'me@example.com', type: 'semantic', effect: 'keep',
      baselineRuleId: 'baseline-news',
    });
    writeFileSync(join(process.env.WINNOW_RULES_DIR, 'baseline-rules.yaml'), `
rules:
  - id: baseline-news
    match: Updated newsletter guidance
    archive: true
`, 'utf8');

    const apiRule = listRulesForApi('me@example.com').rules.find(rule => rule.id === override.id);
    assert.equal(apiRule.match, 'Updated newsletter guidance');
    assert.equal(loadAllRules('me@example.com').rules.find(rule => rule.id === override.id).match,
      'Updated newsletter guidance');
  });

  it('exposes unified assistant rule tools and keeps mutations proposal-gated', async () => {
    const toolNames = ASSISTANT_TOOL_DEFINITIONS.map(tool => tool.name);
    assert.ok(toolNames.includes('rules.list'));
    assert.ok(toolNames.includes('rules.preview'));
    assert.ok(toolNames.includes('rules.upsert'));
    assert.ok(toolNames.includes('rules.disable'));
    assert.ok(toolNames.includes('rules.reset'));
    assert.ok(!toolNames.includes('rules.create'));

    const created = upsertUserRule({
      account: 'me@example.com', type: 'semantic', effect: 'archive', match: 'Routine receipts',
    });
    const conversation = { id: 'conversation-1', scope: 'mailbox', account: 'me@example.com' };
    const prepared = await prepareAssistantTool({
      name: 'rules.reset',
      rawArguments: { account: 'me@example.com', ruleId: created.id },
      conversation,
      latestUserText: 'Reset that rule',
      dependencies: {},
    });
    assert.equal(prepared.kind, 'proposal');
    assert.equal(listUserRuleRecords({ account: 'me@example.com' }).length, 1);

    const result = await executeAssistantProposal({
      tool: 'rules.reset', arguments: prepared.arguments,
    }, conversation, {});
    assert.equal(result.reset, true);
    assert.equal(listUserRuleRecords({ account: 'me@example.com' }).length, 0);
  });

  it('migrates the newest opposing legacy exact rule deterministically', () => {
    listUserRuleRecords();
    closeStoreForTests();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DELETE FROM user_rules;
      DELETE FROM meta WHERE key = 'assistant_rules_to_user_rules_v1';
      INSERT INTO assistant_rules (
        id, account, effect, matcher_kind, matcher_value, description, enabled,
        source_email_item_id, created_by, created_at, updated_at
      ) VALUES
        ('older-archive', 'me@example.com', 'archive', 'sender', 'same@example.com', '', 1, NULL, 'assistant', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('newer-keep', 'me@example.com', 'keep', 'sender', 'same@example.com', '', 1, NULL, 'assistant', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    `);
    legacy.close();
    configureDatabaseForTests(databasePath);

    const migrated = listEffectiveExactRules('me@example.com');
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].id, 'newer-keep');
    assert.equal(migrated[0].effect, 'keep');
  });

  it('binds assistant replacement confirmation to the previewed rule revision', async () => {
    const existing = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'archive',
      matcherKind: 'sender', matcherValue: 'alerts@example.com',
      description: 'Archive alerts',
    });
    const conversation = { id: 'conversation-replace', scope: 'mailbox', account: 'me@example.com' };
    const prepared = await prepareAssistantTool({
      name: 'rules.upsert',
      rawArguments: {
        account: 'me@example.com', type: 'exact', effect: 'keep',
        matcherKind: 'sender', matcherValue: 'alerts@example.com',
        description: 'Keep alerts',
      },
      conversation,
      latestUserText: 'Keep future alerts from this sender',
      dependencies: {},
    });
    assert.deepEqual(prepared.arguments.expectedConflict, {
      ruleId: existing.id,
      updatedAt: existing.updatedAt,
    });
    assert.match(prepared.summary, /replacing the existing rule.*Archive alerts/i);
    const replaced = await executeAssistantProposal({
      tool: 'rules.upsert', arguments: prepared.arguments,
    }, conversation, {});
    assert.equal(replaced.id, existing.id);
    assert.equal(replaced.effect, 'keep');

    const current = getUserRuleRecord(replaced.id);
    const editPrepared = await prepareAssistantTool({
      name: 'rules.upsert',
      rawArguments: {
        id: current.id,
        account: current.account,
        type: 'exact',
        effect: 'archive',
        matcherKind: 'sender',
        matcherValue: 'updated-alerts@example.com',
        description: 'Updated alerts',
      },
      conversation,
      latestUserText: 'Update this rule to archive future messages from the new sender',
      dependencies: {},
    });
    assert.deepEqual(editPrepared.arguments.expectedRule, {
      ruleId: current.id,
      updatedAt: current.updatedAt,
    });
    const edited = await executeAssistantProposal({
      tool: 'rules.upsert', arguments: editPrepared.arguments,
    }, conversation, {});
    assert.equal(edited.id, current.id);
    assert.equal(edited.matcherValue, 'updated-alerts@example.com');
  });

  it('allows an explicit natural-language refinement of a pending rule proposal', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'paycom-message', threadId: 'paycom-thread',
      from: 'Paycom <systemmessage@paycomonline.com>', subject: 'New Check Available',
      archive: false,
    });
    const conversation = createAssistantConversation({
      id: 'conversation-refine', scope: 'email', account: item.account, emailItemId: item.id,
    });
    createAssistantRunWithUserMessage({
      id: 'old-rule-run', conversationId: conversation.id,
      userMessageId: 'old-rule-user-message', idempotencyKey: 'old-rule-run-key',
      requestFingerprint: 'old-rule-fingerprint', leaseToken: 'old-rule-lease',
      text: 'Always archive',
    });
    createAssistantProposal({
      id: 'old-rule-proposal', conversationId: conversation.id, runId: 'old-rule-run',
      tool: 'rules.upsert', risk: 'persistent', summary: 'Archive all messages from Paycom',
      arguments: {
        account: item.account, type: 'exact', effect: 'archive',
        matcherKind: 'sender', matcherValue: 'systemmessage@paycomonline.com',
      },
      confirmationDigest: 'old-digest',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: 'old-key',
    });

    const refined = await prepareAssistantTool({
      name: 'rules.upsert',
      rawArguments: {
        account: item.account, type: 'exact', effect: 'archive',
        matcherKind: 'sender', matcherValue: 'systemmessage@paycomonline.com',
      },
      conversation,
      latestUserText: 'Can we make it specific to this particular email subject from that address?',
      dependencies: {},
    });

    assert.equal(refined.kind, 'proposal');
    assert.equal(refined.arguments.subjectMatchMode, 'exact');
    assert.equal(refined.arguments.subjectMatchValue, 'new check available');
    assert.match(refined.summary, /sender systemmessage@paycomonline\.com with subject exactly/i);

    await assert.rejects(
      prepareAssistantTool({
        name: 'rules.upsert', rawArguments: refined.arguments, conversation,
        latestUserText: 'New Check Available', dependencies: {},
      }),
      error => error.code === 'action_not_requested'
        && /direct request/i.test(error.message),
    );
  });

  it('defaults a bare contextual always-rule to a stable exact subject, not the whole sender', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'stable-message', threadId: 'stable-thread',
      from: 'Paycom <systemmessage@paycomonline.com>', subject: 'New Check Available',
      archive: false,
    });
    const conversation = createAssistantConversation({
      id: 'conversation-narrow-default', scope: 'email', account: item.account, emailItemId: item.id,
    });
    const bare = await prepareAssistantTool({
      name: 'rules.upsert',
      rawArguments: {
        account: item.account, type: 'exact', effect: 'archive',
        matcherKind: 'sender', matcherValue: 'systemmessage@paycomonline.com',
      },
      conversation, latestUserText: 'Always archive', dependencies: {},
    });
    assert.equal(bare.arguments.subjectMatchMode, 'exact');
    assert.equal(bare.arguments.subjectMatchValue, 'new check available');

    const senderWide = await prepareAssistantTool({
      name: 'rules.upsert',
      rawArguments: {
        account: item.account, type: 'exact', effect: 'archive',
        matcherKind: 'sender', matcherValue: 'systemmessage@paycomonline.com',
      },
      conversation, latestUserText: 'Always archive every email from this sender', dependencies: {},
    });
    assert.equal(senderWide.arguments.subjectMatchMode, undefined);
  });

  it('asks for clarification instead of broadening an ambiguous dynamic subject', async () => {
    const item = upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'dynamic-message', threadId: 'dynamic-thread',
      from: 'Digest <digest@example.com>', subject: 'Digest for July 14, 2026', archive: false,
    });
    const conversation = createAssistantConversation({
      id: 'conversation-dynamic-subject', scope: 'email', account: item.account, emailItemId: item.id,
    });
    await assert.rejects(prepareAssistantTool({
      name: 'rules.upsert',
      rawArguments: {
        account: item.account, type: 'exact', effect: 'archive',
        matcherKind: 'sender', matcherValue: 'digest@example.com',
      },
      conversation, latestUserText: 'Always archive', dependencies: {},
    }), error => error.code === 'rule_scope_clarification_required');
  });

  it('supersedes an older pending rule proposal only after storing its replacement', () => {
    const conversation = createAssistantConversation({
      id: 'conversation-supersede', scope: 'mailbox', account: 'me@example.com',
    });
    createAssistantRunWithUserMessage({
      id: 'old-proposal-run', conversationId: conversation.id,
      userMessageId: 'old-proposal-user-message', idempotencyKey: 'old-proposal-run-key',
      requestFingerprint: 'old-proposal-fingerprint', leaseToken: 'old-proposal-lease',
      text: 'Always archive',
    });
    createAssistantProposal({
      id: 'old-proposal', conversationId: conversation.id, runId: 'old-proposal-run',
      tool: 'rules.upsert', risk: 'persistent', summary: 'Old rule', arguments: {},
      confirmationDigest: 'old-digest',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: 'old-proposal-key',
    });
    createAssistantRunWithUserMessage({
      id: 'replacement-run', conversationId: conversation.id,
      userMessageId: 'replacement-user-message', idempotencyKey: 'replacement-run-key',
      requestFingerprint: 'replacement-fingerprint', leaseToken: 'replacement-lease',
      text: 'Make it specific to this subject',
    });
    assert.equal(finishAssistantRunWithProposal({
      runId: 'replacement-run', leaseToken: 'replacement-lease',
      proposal: {
        id: 'replacement-proposal', conversationId: conversation.id,
        tool: 'rules.upsert', risk: 'persistent', summary: 'Replacement rule',
        arguments: {}, confirmationDigest: 'replacement-digest',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        idempotencyKey: 'replacement-proposal-key',
      },
      toolCall: {
        id: 'replacement-tool-call', tool: 'rules.upsert', risk: 'persistent',
        arguments: {}, status: 'proposed',
      },
      message: {
        id: 'replacement-assistant-message', conversationId: conversation.id,
        role: 'assistant', text: 'Replacement rule',
      },
    }), true);
    assert.equal(getAssistantProposal('old-proposal').status, 'cancelled');
    assert.equal(getAssistantProposal('replacement-proposal').status, 'pending');
  });

  it('persists and previews compound sender and subject exact rules', async () => {
    const saved = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'archive',
      matcherKind: 'sender', matcherValue: 'systemmessage@paycomonline.com',
      subjectMatchMode: 'exact', subjectMatchValue: 'New Check Available',
      description: 'Archive Paycom check notices',
    });
    const stored = getUserRuleRecord(saved.id);
    assert.equal(stored.subjectMatchMode, 'exact');
    assert.equal(stored.subjectMatchValue, 'new check available');
    assert.match(stored.conflictKey, /subject:exact:new check available$/);
    const apiRule = listRulesForApi('me@example.com').rules.find(rule => rule.id === saved.id);
    assert.equal(apiRule.subjectMatchMode, 'exact');
    assert.equal(apiRule.subjectMatchValue, 'new check available');

    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'compound-match', threadId: 'compound-match-thread',
      from: 'Paycom <systemmessage@paycomonline.com>', subject: 'Re: New Check Available', archive: false,
    });
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'subject-miss', threadId: 'subject-miss-thread',
      from: 'Paycom <systemmessage@paycomonline.com>', subject: 'Password changed', archive: false,
    });
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'sender-miss', threadId: 'sender-miss-thread',
      from: 'Other <other@example.com>', subject: 'New Check Available', archive: false,
    });
    const preview = await previewUserRule({
      account: saved.account, type: saved.type, effect: saved.effect,
      matcherKind: saved.matcherKind, matcherValue: saved.matcherValue,
      subjectMatchMode: saved.subjectMatchMode, subjectMatchValue: saved.subjectMatchValue,
    });
    assert.equal(preview.matchCount, 1);
    assert.equal(preview.matches[0].messageId, 'compound-match');
    assert.equal(preview.nonMatches.length, 2);
  });

  it('additively migrates older user_rules tables for subject constraints', () => {
    closeStoreForTests();
    const oldDatabasePath = join(tempDir, 'old-user-rules.db');
    const legacy = new DatabaseSync(oldDatabasePath);
    legacy.exec(`
      CREATE TABLE user_rules (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        rule_type TEXT NOT NULL CHECK(rule_type IN ('exact', 'semantic')),
        effect TEXT NOT NULL CHECK(effect IN ('archive', 'keep')),
        match_text TEXT,
        matcher_kind TEXT,
        matcher_value TEXT,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        baseline_rule_id TEXT,
        source_email_item_id TEXT,
        conflict_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account, conflict_key)
      );
      INSERT INTO user_rules (
        id, account, rule_type, effect, matcher_kind, matcher_value, description,
        enabled, source, conflict_key, created_at, updated_at
      ) VALUES (
        'legacy-rule', 'me@example.com', 'exact', 'archive', 'sender',
        'legacy@example.com', 'Legacy rule', 1, 'api',
        'exact:sender:legacy@example.com',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();
    configureDatabaseForTests(oldDatabasePath);
    assert.equal(getUserRuleRecord('legacy-rule').subjectMatchMode, null);
    const compound = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'keep',
      matcherKind: 'sender', matcherValue: 'compound@example.com',
      subjectMatchMode: 'exact', subjectMatchValue: 'Status update',
    });
    assert.equal(getUserRuleRecord(compound.id).subjectMatchValue, 'status update');
  });

  it('does not let YAML import overwrite newer persisted intent or repeat after completion', () => {
    const existing = upsertUserRule({
      account: 'me@example.com', type: 'semantic', effect: 'archive',
      match: 'Messages about personal projects', description: 'Created in the app',
    });

    const first = importUserRules('me@example.com', { dryRun: false });
    assert.equal(first.preservedExisting.length, 1);
    assert.equal(first.preservedExisting[0].id, existing.id);
    assert.equal(listEffectiveSemanticRules('me@example.com')
      .find(rule => rule.id === existing.id).effect, 'archive');

    const edited = upsertUserRule({
      id: existing.id, account: existing.account, type: existing.type,
      effect: 'keep', match: existing.match, description: 'Edited after migration',
      expectedRule: { ruleId: existing.id, updatedAt: existing.updatedAt },
    });
    const repeated = importUserRules('me@example.com', { dryRun: false });
    assert.equal(repeated.alreadyImported, true);
    assert.equal(repeated.imported.length, 0);
    assert.equal(getUserRuleRecord(edited.id).description, 'Edited after migration');
  });

  it('fails closed when the versioned baseline file is malformed', () => {
    writeFileSync(join(process.env.WINNOW_RULES_DIR, 'baseline-rules.yaml'), 'rules: [', 'utf8');
    assert.throws(() => listBaselineRules());
  });

  it('fails closed when the versioned baseline file has the wrong schema', () => {
    writeFileSync(join(process.env.WINNOW_RULES_DIR, 'baseline-rules.yaml'), 'rule: []\n', 'utf8');
    assert.throws(() => listBaselineRules(), /must contain a rules array/i);
  });

  it('refuses to complete YAML migration when a legacy customization cannot be preserved', () => {
    writeFileSync(join(process.env.WINNOW_RULES_DIR, 'rules-me@example.com.yaml'), `
rules:
  - id: baseline-news
    match: A personalized newsletter definition
    archive: false
`, 'utf8');
    const plan = planUserRuleImport('me@example.com');
    assert.equal(plan.skipped.length, 1);
    assert.throws(
      () => importUserRules('me@example.com', { dryRun: false }),
      /cannot apply YAML migration/i,
    );
    assert.equal(listRulesForApi('me@example.com').migrationPending, true);
    assert.equal(loadAllRules('me@example.com').rules.find(rule => rule.id === 'baseline-news').match,
      'A personalized newsletter definition');
  });

  it('previews exact matches and non-matches with deterministic replacement disclosure', async () => {
    const existing = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'keep',
      matcherKind: 'sender', matcherValue: 'sender@example.com',
    });
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-match', threadId: 't-match',
      from: 'Sender <sender@example.com>', subject: 'Matches', archive: false,
    });
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-no-match', threadId: 't-no-match',
      from: 'Other <other@example.com>', subject: 'Does not match', archive: false,
    });

    const preview = await previewUserRule({
      account: 'me@example.com', type: 'exact', effect: 'archive',
      matcherKind: 'sender', matcherValue: 'sender@example.com',
    });
    assert.equal(preview.mode, 'exact');
    assert.equal(preview.evaluatedCount, 2);
    assert.equal(preview.matches.length, 1);
    assert.equal(preview.nonMatches.length, 1);
    assert.equal(preview.conflict.rule.id, existing.id);
    assert.match(preview.note, /would match 1 of 2/i);
  });

  it('bounds semantic preview to stored metadata and leaves Gmail, events, and rules untouched', async () => {
    for (let index = 0; index < 35; index++) {
      upsertEmailItemFromResult({
        account: 'me@example.com', messageId: `m-semantic-${index}`, threadId: `t-semantic-${index}`,
        from: `Sender ${index} <sender${index}@example.com>`, subject: `Message ${index}`,
        summary: index % 2 ? 'Routine receipt' : 'Human request', snippet: `Snippet ${index}`,
        archive: false,
      });
    }
    const rulesBefore = listUserRuleRecords().length;
    const eventsBefore = listEvents({ limit: 500 }).length;
    let sampledMessages;
    const preview = await previewUserRule({
      account: 'me@example.com', type: 'semantic', effect: 'archive', match: 'Routine receipts',
    }, {
      limit: 3,
      evaluator: async ({ messages }) => {
        sampledMessages = messages;
        return {
          model: 'test-model',
          sampledAt: '2026-07-13T20:00:00.000Z',
          evaluations: messages.map((message, index) => ({
            emailItemId: message.id,
            matches: index % 2 === 0,
            confidence: 90 - index,
            reason: index % 2 === 0 ? 'Looks like a receipt' : 'Looks like a request',
          })),
        };
      },
    });

    assert.equal(sampledMessages.length, 30);
    assert.equal(preview.mode, 'semantic');
    assert.equal(preview.evaluatedCount, 30);
    assert.equal(preview.matches.length, 3);
    assert.equal(preview.nonMatches.length, 3);
    assert.equal(preview.model, 'test-model');
    assert.match(preview.note, /stored subject, summary, and snippet fields only/i);
    assert.match(preview.note, /not production-equivalent/i);
    assert.match(preview.note, /does not guarantee/i);
    assert.match(preview.note, /no Gmail, event, or rule state was changed/i);
    assert.equal(listUserRuleRecords().length, rulesBefore);
    assert.equal(listEvents({ limit: 500 }).length, eventsBefore);
  });

  it('bounds semantic provider latency with a typed retryable error', async () => {
    const request = {
      candidate: { match: 'Routine receipts' },
      messages: [{
        id: 'message-timeout', from: 'Sender <sender@example.com>', subject: 'Receipt',
        summary: 'Routine receipt', snippet: 'A receipt',
      }],
    };
    await assert.rejects(
      evaluateSemanticRulePreview({
        ...request,
        timeoutMs: 5,
        generateContent: () => new Promise(() => {}),
      }),
      error => (
        error instanceof SemanticPreviewError
        && error.code === 'semantic_preview_unavailable'
        && error.retryable === true
      ),
    );
    await assert.rejects(
      evaluateSemanticRulePreview({
        ...request,
        generateContent: async () => ({ response: { text: () => '{"results":[]}' } }),
      }),
      error => error instanceof SemanticPreviewError && error.retryable === true,
    );
  });

  it('aggregates raw baseline attribution across accounts in the accountless rule list', () => {
    upsertEmailItemFromResult({
      account: 'me@example.com', messageId: 'm-baseline', threadId: 't-baseline',
      from: 'News <news@example.com>', subject: 'Newsletter', archive: true,
      handlingDecision: {
        effect: 'archive', basis: 'baseline', explanation: 'Baseline newsletter guidance',
        confidence: 94, handledAt: new Date().toISOString(),
        appliedRule: {
          id: 'baseline-news', description: 'Baseline newsletter guidance', scope: 'baseline',
          source: 'baseline', editable: false, attribution: 'model_cited',
          effect: 'archive',
          revision: ruleRevision({
            id: 'baseline-news', type: 'semantic', effect: 'archive',
            match: 'Baseline newsletter guidance', source: 'baseline',
          }),
        },
      },
    });

    const baseline = listRulesForApi().rules.find(rule => rule.id === 'baseline:baseline-news');
    assert.equal(baseline.activity.appliedCount30Days, 1);
    assert.equal(baseline.activity.recent[0].messageId, 'm-baseline');
  });
});
