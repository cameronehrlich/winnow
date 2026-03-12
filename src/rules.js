import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');

function accountRulesPath(account) {
  return join(CONFIG_DIR, `rules-${account}.yaml`);
}

export function loadBaselineRules() {
  const raw = readFileSync(join(CONFIG_DIR, 'baseline-rules.yaml'), 'utf8');
  return yaml.load(raw);
}

export function loadAccountRules(account) {
  const path = accountRulesPath(account);
  try {
    if (!existsSync(path)) return { rules: [] };
    const raw = readFileSync(path, 'utf8');
    const data = yaml.load(raw);
    return data || { rules: [] };
  } catch {
    return { rules: [] };
  }
}

/**
 * Load all rules for a specific account.
 * Account rules override baseline rules with the same id.
 */
export function loadAllRules(account) {
  const baseline = loadBaselineRules();
  const acct = account ? loadAccountRules(account) : { rules: [] };

  const baselineRules = baseline.rules || [];
  const acctRules = acct.rules || [];

  // Account rules override baseline rules with the same id
  const acctIds = new Set(acctRules.map(r => r.id));
  const merged = [
    ...acctRules,
    ...baselineRules.filter(r => !acctIds.has(r.id)),
  ];

  return { rules: merged };
}

export function formatRulesForPrompt(rules) {
  return rules.map(r => {
    const action = r.archive === true ? 'archive' : r.archive === false ? 'keep in inbox' : (r.priority === 'low' ? 'archive' : 'keep in inbox');
    return `- ${r.match} → ${action}`;
  }).join('\n');
}

export function addRule(description, archive, account) {
  if (!account) throw new Error('Account is required when adding a rule');
  const acct = loadAccountRules(account);
  const rules = acct.rules || [];
  const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const suffix = Date.now().toString(36).slice(-4);
  const id = `${slug}-${suffix}`;

  rules.push({
    id,
    match: description,
    archive,
    added: new Date().toISOString().split('T')[0],
    source: 'user',
  });

  const content = yaml.dump({ rules }, { lineWidth: 120 });
  writeFileSync(accountRulesPath(account), content, 'utf8');
  return id;
}

export function removeRule(id, account) {
  if (!account) throw new Error('Account is required when removing a rule');
  const acct = loadAccountRules(account);
  const rules = (acct.rules || []).filter(r => r.id !== id);
  const content = yaml.dump({ rules }, { lineWidth: 120 });
  writeFileSync(accountRulesPath(account), content, 'utf8');
}

export function listRules(account) {
  const { rules } = loadAllRules(account);
  return rules.map(r => ({
    ...r,
    source: r.source || 'baseline',
  }));
}
