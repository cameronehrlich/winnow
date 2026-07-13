import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { getAccounts } from './config.js';
import { matchAssistantRule, validateAssistantRule } from './assistant-rules.js';
import {
  deleteUserRuleRecord,
  getSyncState,
  getUserRuleRecord,
  listRecentTrackedEmailItems,
  listUserRuleRecords,
  setSyncState,
  setUserRuleEnabled,
  upsertUserRuleRecord,
} from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES_DIR = join(__dirname, '..', 'config');
const IMPORT_STATE_PREFIX = 'user_rules_yaml_import_v1:';
const USER_RULE_SOURCES = new Set(['assistant', 'api', 'import']);
const USER_RULE_INPUT_FIELDS = new Set([
  'id', 'account', 'type', 'effect', 'archive', 'match', 'matcherKind', 'matcherValue',
  'description', 'enabled', 'baselineRuleId', 'sourceEmailItemId',
]);
const OPERATOR_FIELDS = new Set([
  'action', 'always', 'trigger', 'command', 'script', 'shell', 'suppress_feed', 'suppressFeed',
].map(field => field.toLowerCase()));

function rulesDirectory() {
  return process.env.WINNOW_RULES_DIR || DEFAULT_RULES_DIR;
}

function readRulesFile(path, { strict = false } = {}) {
  try {
    if (!existsSync(path)) {
      if (strict) throw new Error(`required rules file is missing: ${path}`);
      return [];
    }
    const parsed = yaml.load(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed?.rules)) {
      if (strict) throw new TypeError(`required rules file must contain a rules array: ${path}`);
      return [];
    }
    return parsed.rules;
  } catch (err) {
    if (strict) throw err;
    return [];
  }
}

function baselineRows() {
  return readRulesFile(join(rulesDirectory(), 'baseline-rules.yaml'), { strict: true });
}

function accountRows(account) {
  return readRulesFile(join(rulesDirectory(), `rules-${account}.yaml`));
}

function hasOperatorFields(rule) {
  return Boolean(rule && typeof rule === 'object' && Object.keys(rule)
    .some(field => OPERATOR_FIELDS.has(field.toLowerCase())));
}

function requiredText(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length > max) throw new RangeError(`${name} exceeds ${max} characters`);
  if (/\0/.test(normalized)) throw new TypeError(`${name} contains invalid control characters`);
  return normalized;
}

function effectFrom(rule) {
  if (rule.effect === 'archive' || rule.archive === true || rule.priority === 'low') return 'archive';
  if (rule.effect === 'keep' || rule.archive === false) return 'keep';
  throw new TypeError('effect must be archive or keep');
}

function semanticConflictKey(match) {
  const digest = createHash('sha256').update(match.toLowerCase()).digest('base64url').slice(0, 24);
  return `semantic:${digest}`;
}

function importedRuleId(account, legacyId) {
  const normalizedId = requiredText(legacyId, 'rule id', 128);
  return `import-${createHash('sha256').update(`${account}\0${normalizedId}`).digest('base64url').slice(0, 24)}`;
}

function configuredAccount(account) {
  const normalized = normalizedAccount(account);
  if (!getAccounts().some(item => item.email.toLowerCase() === normalized)) {
    throw new TypeError('account is not configured in Winnow');
  }
  return normalized;
}

function normalizedAccount(account) {
  const normalized = requiredText(account, 'account', 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw new TypeError('account is invalid');
  return normalized;
}

function normalizedBaselineRule(rule) {
  return {
    id: requiredText(rule.id, 'baseline rule id', 128),
    type: 'semantic',
    effect: effectFrom(rule),
    match: requiredText(rule.match, 'baseline rule match', 2000),
  };
}

export function listBaselineRules() {
  return baselineRows().map(normalizedBaselineRule);
}

function baselineById(id) {
  return listBaselineRules().find(rule => rule.id === id) || null;
}

function withCurrentBaselineMatch(rule) {
  if (!rule?.baselineRuleId) return rule;
  const baseline = baselineById(rule.baselineRuleId);
  return baseline ? { ...rule, type: 'semantic', match: baseline.match } : rule;
}

export function normalizeUserRule(input, { source = 'api', existing = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('rule must be an object');
  const unexpected = Object.keys(input).find(field => !USER_RULE_INPUT_FIELDS.has(field));
  if (unexpected) throw new TypeError(`unexpected rule field: ${unexpected}`);
  if (hasOperatorFields(input)) throw new TypeError('executable action-hook fields are operator-only');
  const normalizedSource = USER_RULE_SOURCES.has(source) ? source : 'api';
  const id = input.id === undefined
    ? (existing?.id || randomUUID())
    : requiredText(input.id, 'id', 128);
  const account = configuredAccount(input.account ?? existing?.account);
  const baselineRuleId = input.baselineRuleId ?? existing?.baselineRuleId ?? null;
  const baseline = baselineRuleId ? baselineById(requiredText(baselineRuleId, 'baselineRuleId', 128)) : null;
  if (baselineRuleId && !baseline) throw new TypeError('baselineRuleId does not identify a versioned baseline rule');
  const inferredType = input.type
    || existing?.type
    || (input.matcherKind || input.matcherValue ? 'exact' : 'semantic');
  if (!['exact', 'semantic'].includes(inferredType)) throw new TypeError('type must be exact or semantic');
  if (baseline && inferredType !== 'semantic') throw new TypeError('baseline overrides must be semantic rules');
  const effect = effectFrom({ ...existing, ...input });
  const rawDescription = input.description ?? existing?.description ?? '';
  if (typeof rawDescription !== 'string') throw new TypeError('description must be a string');
  const description = rawDescription.trim().slice(0, 1000);
  const enabled = input.enabled ?? existing?.enabled ?? true;
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (baseline && !enabled) throw new TypeError('baseline overrides cannot be disabled; reset the override instead');
  const rawSourceEmailItemId = input.sourceEmailItemId ?? existing?.sourceEmailItemId ?? null;
  const sourceEmailItemId = rawSourceEmailItemId === null
    ? null
    : requiredText(rawSourceEmailItemId, 'sourceEmailItemId', 500);

  if (inferredType === 'exact') {
    const exact = validateAssistantRule({
      account,
      effect,
      matcherKind: input.matcherKind ?? existing?.matcherKind,
      matcherValue: input.matcherValue ?? existing?.matcherValue,
      enabled,
    });
    return {
      id,
      account,
      type: 'exact',
      effect,
      match: '',
      matcherKind: exact.matcherKind,
      matcherValue: exact.matcherValue,
      description,
      enabled,
      source: normalizedSource,
      baselineRuleId: null,
      sourceEmailItemId,
      conflictKey: `exact:${exact.matcherKind}:${exact.matcherValue}`,
    };
  }

  const match = baseline
    ? baseline.match
    : requiredText(input.match ?? existing?.match, 'match', 2000);
  if (baseline && input.match !== undefined && requiredText(input.match, 'match', 2000) !== baseline.match) {
    throw new TypeError('baseline override match text is read-only');
  }
  return {
    id,
    account,
    type: 'semantic',
    effect,
    match,
    matcherKind: null,
    matcherValue: null,
    description,
    enabled,
    source: normalizedSource,
    baselineRuleId: baseline?.id || null,
    sourceEmailItemId,
    conflictKey: baseline ? `baseline:${baseline.id}` : semanticConflictKey(match),
  };
}

function toApiRule(rule, scope = 'user') {
  rule = withCurrentBaselineMatch(rule);
  return {
    id: rule.id,
    account: rule.account ?? null,
    type: rule.type,
    effect: rule.effect,
    ...(rule.type === 'semantic' ? { match: rule.match } : {
      matcherKind: rule.matcherKind,
      matcherValue: rule.matcherValue,
    }),
    description: rule.description || '',
    enabled: rule.enabled !== false,
    scope,
    source: scope === 'baseline' ? 'baseline' : rule.source,
    editable: scope === 'user',
    ...(rule.baselineRuleId ? { baselineRuleId: rule.baselineRuleId } : {}),
    ...(rule.sourceEmailItemId ? { sourceEmailItemId: rule.sourceEmailItemId } : {}),
    ...(rule.createdAt ? { createdAt: rule.createdAt } : {}),
    ...(rule.updatedAt ? { updatedAt: rule.updatedAt } : {}),
  };
}

export function upsertUserRule(input, { source = 'api' } = {}) {
  const existing = input?.id ? getUserRuleRecord(input.id) : null;
  const normalized = normalizeUserRule(input, { source, existing });
  const saved = upsertUserRuleRecord(normalized);
  if (existing && saved.id !== existing.id) deleteUserRuleRecord(existing.id);
  return toApiRule(saved);
}

export function updateUserRule(id, patch, { source = 'api' } = {}) {
  const existing = getUserRuleRecord(id);
  if (!existing) return null;
  return upsertUserRule({ ...patch, id, account: existing.account }, { source });
}

export function disableUserRule(id) {
  const existing = getUserRuleRecord(id);
  if (existing?.baselineRuleId) {
    throw new TypeError('baseline overrides cannot be disabled; reset the override instead');
  }
  const rule = setUserRuleEnabled(id, false);
  return rule ? toApiRule(rule) : null;
}

export function resetUserRule(id) {
  const rule = getUserRuleRecord(id);
  if (!rule) return null;
  deleteUserRuleRecord(id);
  return { reset: true, restoredBaselineRuleId: rule.baselineRuleId || null };
}

export function listRulesForApi(account) {
  if (!account) {
    const accounts = getAccounts().map(item => item.email);
    const migrationPendingByAccount = Object.fromEntries(accounts.map(email => [
      email,
      getSyncState(`${IMPORT_STATE_PREFIX}${email}`, '') !== 'complete',
    ]));
    const userRules = listUserRuleRecords().map(rule => toApiRule(rule));
    const baseline = listBaselineRules().map(rule => ({
      ...toApiRule({ ...rule, id: `baseline:${rule.id}`, account: null, description: '', enabled: true }, 'baseline'),
      baselineRuleId: rule.id,
    }));
    return {
      rules: [...userRules, ...baseline],
      migrationPending: Object.values(migrationPendingByAccount).some(Boolean),
      migrationPendingByAccount,
    };
  }
  const normalizedAccount = configuredAccount(account);
  const userRules = listUserRuleRecords({ account: normalizedAccount });
  const shadowedBaseline = new Set(userRules.map(rule => rule.baselineRuleId).filter(Boolean));
  const baseline = listBaselineRules()
    .filter(rule => !shadowedBaseline.has(rule.id))
    .map(rule => toApiRule({ ...rule, account: normalizedAccount, description: '', enabled: true }, 'baseline'));
  return {
    rules: [...userRules.map(rule => toApiRule(rule)), ...baseline],
    migrationPending: getSyncState(`${IMPORT_STATE_PREFIX}${normalizedAccount}`, '') !== 'complete',
  };
}

function semanticYamlRule(rule, account, source) {
  return {
    id: requiredText(rule.id, 'rule id', 128),
    account,
    type: 'semantic',
    effect: effectFrom(rule),
    match: requiredText(rule.match, 'match', 2000),
    description: '',
    enabled: true,
    source,
  };
}

function legacySemanticRules(account, { operatorOnly = false } = {}) {
  const rows = accountRows(account).filter(rule => hasOperatorFields(rule) === operatorOnly);
  const rules = [];
  for (const row of rows) {
    try {
      if (!row?.match) continue;
      rules.push(semanticYamlRule(row, account, operatorOnly ? 'operator' : 'legacy'));
    } catch {
      // Invalid legacy rows were previously ignored by the prompt formatter in practice.
    }
  }
  return rules;
}

export function listEffectiveSemanticRules(account) {
  const normalized = normalizedAccount(account);
  const persisted = listUserRuleRecords({ account: normalized })
    .filter(rule => rule.type === 'semantic')
    .map(withCurrentBaselineMatch);
  const operator = legacySemanticRules(normalized, { operatorOnly: true });
  const importComplete = getSyncState(`${IMPORT_STATE_PREFIX}${normalized}`, '') === 'complete';
  const legacy = importComplete ? [] : legacySemanticRules(normalized);
  const shadowedBaseline = new Set(persisted.map(rule => rule.baselineRuleId).filter(Boolean));
  const candidates = [
    ...operator,
    ...persisted.filter(rule => rule.enabled),
    ...legacy,
    ...listBaselineRules()
      .filter(rule => !shadowedBaseline.has(rule.id))
      .map(rule => ({ ...rule, account: normalized, source: 'baseline', enabled: true })),
  ];
  const seenIds = new Set();
  return candidates.filter(rule => {
    if (seenIds.has(rule.id)) return false;
    seenIds.add(rule.id);
    return true;
  });
}

export function listEffectiveExactRules(account) {
  return listUserRuleRecords({ account: normalizedAccount(account), enabledOnly: true })
    .filter(rule => rule.type === 'exact');
}

export function listOperatorActionRules(account) {
  return accountRows(normalizedAccount(account)).filter(rule => hasOperatorFields(rule));
}

export function planUserRuleImport(account) {
  const normalizedAccount = configuredAccount(account);
  const baselineIds = new Set(listBaselineRules().map(rule => rule.id));
  const candidates = [];
  const skipped = [];
  let operatorHookCount = 0;
  for (const row of accountRows(normalizedAccount)) {
    if (hasOperatorFields(row)) {
      operatorHookCount += 1;
      continue;
    }
    try {
      if (!row?.match) throw new TypeError('match is required');
      const baselineRuleId = baselineIds.has(row.id) ? row.id : null;
      candidates.push(normalizeUserRule({
        id: importedRuleId(normalizedAccount, row.id),
        account: normalizedAccount,
        type: 'semantic',
        effect: effectFrom(row),
        match: row.match,
        baselineRuleId,
        description: 'Imported from account YAML',
      }, { source: 'import' }));
    } catch (err) {
      skipped.push({ id: String(row?.id || ''), reason: err.message });
    }
  }
  return {
    account: normalizedAccount,
    dryRun: true,
    alreadyImported: getSyncState(`${IMPORT_STATE_PREFIX}${normalizedAccount}`, '') === 'complete',
    candidates: candidates.map(rule => toApiRule(rule)),
    skipped,
    operatorHookCount,
  };
}

export function importUserRules(account, { dryRun = true } = {}) {
  const plan = planUserRuleImport(account);
  if (dryRun) return plan;
  if (plan.skipped.length) {
    throw new TypeError(`cannot apply YAML migration while ${plan.skipped.length} rule(s) are skipped`);
  }
  if (plan.alreadyImported) {
    return { ...plan, dryRun: false, imported: [], preservedExisting: [], candidates: undefined };
  }
  const existingByConflict = new Map(listUserRuleRecords({ account: plan.account })
    .map(rule => [rule.conflictKey, rule]));
  const imported = [];
  const preservedExisting = [];
  for (const candidate of plan.candidates) {
    const input = {
      id: candidate.id,
      account: candidate.account,
      type: candidate.type,
      effect: candidate.effect,
      match: candidate.match,
      description: candidate.description,
      enabled: candidate.enabled,
      baselineRuleId: candidate.baselineRuleId,
    };
    const normalized = normalizeUserRule(input, { source: 'import' });
    const existing = existingByConflict.get(normalized.conflictKey);
    if (existing) {
      preservedExisting.push(toApiRule(existing));
      continue;
    }
    const saved = upsertUserRule(input, { source: 'import' });
    imported.push(saved);
    existingByConflict.set(normalized.conflictKey, getUserRuleRecord(saved.id));
  }
  setSyncState(`${IMPORT_STATE_PREFIX}${plan.account}`, 'complete');
  return { ...plan, dryRun: false, imported, preservedExisting, candidates: undefined };
}

export function previewUserRule(input, { limit = 10 } = {}) {
  const normalized = normalizeUserRule(input, { source: 'api' });
  if (normalized.type === 'semantic') {
    return {
      candidate: toApiRule(normalized),
      matchCount: null,
      evidence: [],
      note: 'Semantic rules are evaluated by the classifier; Winnow does not guess matches during preview.',
    };
  }
  const recent = listRecentTrackedEmailItems({ account: normalized.account, days: 90, limit: 100 });
  const matches = recent.filter(message => matchAssistantRule(normalized, message)).slice(0, limit);
  return {
    candidate: toApiRule(normalized),
    matchCount: matches.length,
    sampledAtMost: 100,
    evidence: matches.map(message => ({
      account: message.account,
      messageId: message.messageId,
      threadId: message.threadId,
      subject: message.subject,
      from: message.from,
      date: message.processedAt,
      snippet: message.snippet,
    })),
  };
}
