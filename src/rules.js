import {
  listBaselineRules,
  listEffectiveSemanticRules,
  listRulesForApi,
  resetUserRule,
  upsertUserRule,
} from './user-rules.js';
import { getUserRuleRecord } from './store.js';
import { ruleRevision } from './rule-revisions.js';

export function loadBaselineRules() {
  return {
    rules: listBaselineRules().map(rule => ({
      id: rule.id,
      match: rule.match,
      archive: rule.effect === 'archive',
      source: 'baseline',
      description: rule.match,
      scope: 'baseline',
      editable: false,
      revision: ruleRevision({ ...rule, source: 'baseline' }),
    })),
  };
}

/**
 * Return classification guidance only. Executable account YAML fields are
 * deliberately stripped here and are loaded separately by scan.js.
 */
export function loadAllRules(account) {
  if (!account) return loadBaselineRules();
  return {
    rules: listEffectiveSemanticRules(account).map(rule => ({
      id: rule.id,
      match: rule.match,
      archive: rule.effect === 'archive',
      source: rule.source,
      description: rule.description || rule.match,
      scope: rule.source === 'baseline'
        ? 'baseline'
        : (['operator', 'legacy'].includes(rule.source) ? 'server' : 'user'),
      editable: !['baseline', 'operator', 'legacy'].includes(rule.source),
      revision: ruleRevision(rule),
    })),
  };
}

export function formatRulesForPrompt(rules) {
  return rules.map(rule => {
    const action = rule.archive === true
      ? 'archive'
      : (rule.archive === false ? 'keep in inbox' : (rule.priority === 'low' ? 'archive' : 'keep in inbox'));
    return `- [rule:${rule.id}] ${rule.match} → ${action}`;
  }).join('\n');
}

export function addRule(description, archive, account) {
  const rule = upsertUserRule({
    account,
    type: 'semantic',
    match: description,
    effect: archive ? 'archive' : 'keep',
    description: 'Created with Winnow CLI',
  }, { source: 'api' });
  return rule.id;
}

export function removeRule(id, account) {
  const existing = getUserRuleRecord(id);
  if (!existing || existing.account !== account) throw new Error('Rule not found for account');
  resetUserRule(id);
}

export function listRules(account) {
  return listRulesForApi(account).rules.map(rule => ({
    id: rule.id,
    match: rule.type === 'semantic'
      ? rule.match
      : `${rule.matcherKind} equals ${rule.matcherValue}`,
    archive: rule.effect === 'archive',
    source: rule.source,
    enabled: rule.enabled,
    type: rule.type,
  }));
}
