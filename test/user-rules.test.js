import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { reloadConfig } from '../src/config.js';
import { loadAllRules } from '../src/rules.js';
import {
  ASSISTANT_TOOL_DEFINITIONS,
  executeAssistantProposal,
  prepareAssistantTool,
} from '../src/assistant-tools.js';
import {
  closeStoreForTests,
  configureDatabaseForTests,
  getUserRuleRecord,
  listUserRuleRecords,
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

  it('replaces exact conflicts deterministically instead of stacking opposites', () => {
    const first = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'archive',
      matcherKind: 'sender', matcherValue: 'Sender@Example.com',
    }, { source: 'assistant' });
    const replacement = upsertUserRule({
      account: 'me@example.com', type: 'exact', effect: 'keep',
      matcherKind: 'sender', matcherValue: 'sender@example.com',
    }, { source: 'api' });
    assert.equal(replacement.id, first.id);
    assert.equal(replacement.effect, 'keep');
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

  it('customizes a read-only baseline through an override and reset restores it', () => {
    importUserRules('me@example.com', { dryRun: false });
    const override = upsertUserRule({
      account: 'me@example.com', type: 'semantic', effect: 'keep',
      baselineRuleId: 'baseline-news',
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
});
