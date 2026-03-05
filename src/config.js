import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'config.yaml');

let cachedConfig;

export function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  cachedConfig = yaml.load(raw);
  return cachedConfig;
}

export function getAccounts() {
  return loadConfig().accounts || [];
}

export function getAdapter() {
  return loadConfig().adapter || 'gog';
}
