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

function readEnv(name) {
  return name ? process.env[name] || null : null;
}

function accountForEmail(email) {
  if (!email) return null;
  return getAccounts().find(a => a.email === email) || null;
}

function tokenFromConfig(value, envName, fallbackValue, fallbackEnvName) {
  return readEnv(envName)
    || value
    || readEnv(fallbackEnvName)
    || fallbackValue
    || null;
}

export function getSlackRoutingForAccount(email = '') {
  const config = loadConfig();
  const account = accountForEmail(email);
  const accountSlack = account?.slack || {};
  const globalSlack = config.slack || {};
  const hasAccountSlackTokens = Boolean(
    accountSlack.bot_token
    || accountSlack.bot_token_env
    || accountSlack.app_token
    || accountSlack.app_token_env
  );

  return {
    account: email || '',
    channelId: accountSlack.channel_id || account?.channel || globalSlack.channel_id || null,
    botToken: hasAccountSlackTokens
      ? (readEnv(accountSlack.bot_token_env) || accountSlack.bot_token || null)
      : tokenFromConfig(globalSlack.bot_token, null, null, 'SLACK_BOT_TOKEN'),
    appToken: hasAccountSlackTokens
      ? (readEnv(accountSlack.app_token_env) || accountSlack.app_token || null)
      : tokenFromConfig(globalSlack.app_token, null, null, 'SLACK_APP_TOKEN'),
  };
}

export function getSlackActionRoutings() {
  const routes = [];
  const seen = new Set();

  const addRoute = (route) => {
    if (!route.botToken || !route.appToken) return;
    const key = `${route.botToken}\0${route.appToken}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push(route);
  };

  addRoute(getSlackRoutingForAccount(''));
  for (const account of getAccounts()) {
    addRoute(getSlackRoutingForAccount(account.email));
  }

  return routes;
}

export function getAppToken() {
  return getSlackRoutingForAccount('').appToken;
}

export function getAccountEmails() {
  return getAccounts().map(a => a.email);
}

export function getScanSearchQuery(config = loadConfig()) {
  return config.scan?.search_query || 'in:inbox is:unread newer_than:1d';
}

export const DEFAULT_CLASSIFICATION_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_ASSISTANT_MODEL = 'gemini-3.5-flash';

function configuredModelName(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function getClassificationModelName(config = loadConfig()) {
  return configuredModelName(
    config.model?.classification_name,
    configuredModelName(config.model?.name, DEFAULT_CLASSIFICATION_MODEL)
  );
}

export function getAssistantModelName(config = loadConfig()) {
  return configuredModelName(
    config.model?.assistant_name,
    configuredModelName(config.model?.name, DEFAULT_ASSISTANT_MODEL)
  );
}

export function getChannelForAccount(email) {
  return getSlackRoutingForAccount(email).channelId;
}

export function getAdapter() {
  return loadConfig().adapter || 'gog';
}
