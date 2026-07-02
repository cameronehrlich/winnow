import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAccounts, getAdapter } from './config.js';

const execFileAsync = promisify(execFile);
const MIN_GOG_VERSION = '0.31.1';

function commandError(err) {
  const stderr = String(err.stderr || '').trim();
  return stderr || err.message;
}

export function parseGogVersion(output) {
  const match = String(output || '').match(/v?(\d+\.\d+\.\d+)/);
  return match?.[1] || '';
}

export function compareVersions(a, b) {
  const left = String(a || '').split('.').map(value => Number.parseInt(value, 10) || 0);
  const right = String(b || '').split('.').map(value => Number.parseInt(value, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function extractGogLabels(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.labels)) return data.labels;
  if (Array.isArray(data?.Labels)) return data.Labels;
  return null;
}

export function extractGogMessages(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.Messages)) return data.Messages;
  return null;
}

export function extractGogLabelIds(data) {
  const candidates = [
    data?.labelIds,
    data?.LabelIds,
    data?.message?.labelIds,
    data?.message?.LabelIds,
    data?.payload?.labelIds,
    data?.message?.payload?.labelIds,
  ];
  return candidates.find(Array.isArray) || null;
}

async function runGog(args) {
  return execFileAsync('gog', args, {
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function runGogJson(args) {
  const { stdout } = await runGog([...args, '--json', '--no-input']);
  return JSON.parse(stdout);
}

async function checkGogVersion(result) {
  try {
    const { stdout } = await runGog(['--version']);
    const version = parseGogVersion(stdout);
    if (!version) {
      result.issues.push('gog is installed but its version output could not be parsed');
    } else if (compareVersions(version, MIN_GOG_VERSION) < 0) {
      result.issues.push(`gog ${version} is too old; install gogcli ${MIN_GOG_VERSION} or newer`);
    } else {
      result.ok.push(`gog ${version} is installed`);
    }
  } catch (err) {
    const hint = err.code === 'ENOENT'
      ? 'gog was not found on PATH; install it with `brew bundle` or `brew install gogcli`'
      : `gog --version failed: ${commandError(err)}`;
    result.issues.push(hint);
  }
}

async function checkGogAccount(account, result) {
  result.ok.push(`Checking gog Gmail access for ${account}`);

  let labels;
  try {
    labels = extractGogLabels(await runGogJson([
      'gmail', 'labels', 'list',
      '--account', account,
    ]));
  } catch (err) {
    result.issues.push(`${account}: gog labels list failed: ${commandError(err)}`);
    return;
  }

  if (!Array.isArray(labels)) {
    result.issues.push(`${account}: gog labels list returned an unexpected JSON shape`);
    return;
  }
  result.ok.push(`${account}: labels list JSON shape ok (${labels.length} labels)`);

  let messages;
  try {
    messages = extractGogMessages(await runGogJson([
      'gmail', 'messages', 'search',
      'in:inbox newer_than:365d',
      '--max', '1',
      '--account', account,
    ]));
  } catch (err) {
    result.issues.push(`${account}: gog messages search failed: ${commandError(err)}`);
    return;
  }

  if (!Array.isArray(messages)) {
    result.issues.push(`${account}: gog messages search returned an unexpected JSON shape`);
    return;
  }
  result.ok.push(`${account}: messages search JSON shape ok (${messages.length} result${messages.length === 1 ? '' : 's'})`);

  const firstMessage = messages.find(message => message?.id);
  if (!firstMessage) {
    result.warnings.push(`${account}: no recent inbox message found for gog get shape check`);
    return;
  }

  let message;
  try {
    message = await runGogJson([
      'gmail', 'get', firstMessage.id,
      '--account', account,
    ]);
  } catch (err) {
    result.issues.push(`${account}: gog gmail get failed: ${commandError(err)}`);
    return;
  }

  const labelIds = extractGogLabelIds(message);
  if (!Array.isArray(labelIds)) {
    result.issues.push(`${account}: gog gmail get returned an unexpected label JSON shape`);
    return;
  }
  result.ok.push(`${account}: gmail get JSON shape ok`);
}

function printResult(result) {
  console.log('\nWinnow Doctor\n');

  if (result.ok.length) {
    console.log('Passing:');
    for (const line of result.ok) console.log(`  - ${line}`);
  }

  if (result.warnings.length) {
    console.log('\nWarnings:');
    for (const line of result.warnings) console.log(`  - ${line}`);
  }

  if (result.issues.length) {
    console.log('\nIssues:');
    for (const line of result.issues) console.log(`  - ${line}`);
  }

  if (!result.issues.length) {
    console.log('\nDoctor checks passed');
  }
}

export async function runDoctor({ account = '' } = {}) {
  const result = { ok: [], warnings: [], issues: [], healthy: false };
  const adapter = getAdapter();

  const nodeVersion = process.versions.node;
  if (compareVersions(nodeVersion, '22.5.0') < 0) {
    result.issues.push(`Node ${nodeVersion} is too old; use Node 22.5.0 or newer`);
  } else {
    result.ok.push(`Node ${nodeVersion} is supported`);
  }

  if (adapter !== 'gog') {
    result.warnings.push(`No doctor checks are implemented for adapter "${adapter}"`);
    result.healthy = result.issues.length === 0;
    printResult(result);
    return result;
  }

  await checkGogVersion(result);

  const accounts = account ? [{ email: account }] : getAccounts();
  if (!accounts.length) {
    result.issues.push('No accounts configured in config/config.yaml');
  }

  for (const acct of accounts) {
    await checkGogAccount(acct.email, result);
  }

  result.healthy = result.issues.length === 0;
  printResult(result);
  return result;
}
