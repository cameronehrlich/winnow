import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(__dirname, '..', 'config', 'config.yaml');
const DEFAULT_ENV_PATH = join(__dirname, '..', '.env');

function configPath() {
  return process.env.WINNOW_CONFIG_PATH || DEFAULT_CONFIG_PATH;
}

function envPath() {
  return process.env.WINNOW_ENV_PATH || DEFAULT_ENV_PATH;
}

let cachedConfig;

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadLocalEnv() {
  try {
    const raw = readFileSync(envPath(), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) {
        process.env[key] = unquoteEnvValue(value);
      }
    }
  } catch {
    // Local .env is optional. PM2 or the shell may provide credentials directly.
  }
}

loadLocalEnv();

export function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const raw = readFileSync(configPath(), 'utf8');
  cachedConfig = yaml.load(raw);
  return cachedConfig;
}

export function reloadConfig() {
  cachedConfig = null;
  return loadConfig();
}

export function setConfigField(key, value) {
  const path = configPath();
  const raw = readFileSync(path, 'utf8');
  const config = yaml.load(raw);
  config[key] = value;
  writeFileSync(path, yaml.dump(config, { lineWidth: -1 }));
  cachedConfig = null; // bust cache
}

export function getAccounts() {
  const accounts = loadConfig().accounts || [];
  // Support both string ("email@x.com") and object ({ email, channel }) formats
  return accounts.map(a => typeof a === 'string' ? { email: a, channel: null } : a);
}

export function getAppToken() {
  const config = loadConfig();
  return config.slack?.app_token || null;
}

export function getAccountEmails() {
  return getAccounts().map(a => a.email);
}

export function getChannelForAccount(email) {
  const account = getAccounts().find(a => a.email === email);
  if (account?.channel) return account.channel;
  // Fall back to global channel
  return loadConfig().slack?.channel_id || null;
}

export function getAdapter() {
  return loadConfig().adapter || 'gog';
}
