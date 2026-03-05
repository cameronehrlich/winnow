import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');

export function loadBaselineRules() {
  const raw = readFileSync(join(CONFIG_DIR, 'baseline-rules.yaml'), 'utf8');
  return yaml.load(raw);
}

export function loadCustomRules() {
  try {
    const raw = readFileSync(join(CONFIG_DIR, 'rules.yaml'), 'utf8');
    const data = yaml.load(raw);
    return data || { rules: [] };
  } catch {
    return { rules: [] };
  }
}

export function loadAllRules() {
  const baseline = loadBaselineRules();
  const custom = loadCustomRules();

  const baselineRules = baseline.rules || [];
  const customRules = custom.rules || [];

  // Custom rules override baseline rules with the same id
  const customIds = new Set(customRules.map(r => r.id));
  const merged = [
    ...customRules,
    ...baselineRules.filter(r => !customIds.has(r.id)),
  ];

  return {
    rules: merged,
    neverArchive: baseline.never_archive || [],
  };
}

export function formatRulesForPrompt(rules) {
  return rules.map(r => `- ${r.match} → ${r.priority}`).join('\n');
}

export function addRule(description, priority) {
  const custom = loadCustomRules();
  const rules = custom.rules || [];
  const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const suffix = Date.now().toString(36).slice(-4);
  const id = `${slug}-${suffix}`;

  rules.push({
    id,
    match: description,
    priority,
    added: new Date().toISOString().split('T')[0],
    source: 'user',
  });

  const content = yaml.dump({ rules }, { lineWidth: 120 });
  writeFileSync(join(CONFIG_DIR, 'rules.yaml'), content, 'utf8');
  return id;
}

export function removeRule(id) {
  const custom = loadCustomRules();
  const rules = (custom.rules || []).filter(r => r.id !== id);
  const content = yaml.dump({ rules }, { lineWidth: 120 });
  writeFileSync(join(CONFIG_DIR, 'rules.yaml'), content, 'utf8');
}

export function listRules() {
  const { rules } = loadAllRules();
  return rules.map(r => ({
    ...r,
    source: r.source || 'baseline',
  }));
}
