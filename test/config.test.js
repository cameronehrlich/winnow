import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_CLASSIFICATION_MODEL,
  getAssistantModelName,
  getClassificationModelName,
  getSlackActionRoutings,
  getSlackRoutingForAccount,
  getScanSearchQuery,
  reloadConfig,
} from '../src/config.js';

let tempDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-config-'));
  process.env.WINNOW_CONFIG_PATH = join(tempDir, 'config.yaml');
  process.env.SLACK_BOT_TOKEN = 'xoxb-default';
  process.env.SLACK_APP_TOKEN = 'xapp-default';
  process.env.WORK_SLACK_BOT_TOKEN = 'xoxb-work';
  process.env.WORK_SLACK_APP_TOKEN = 'xapp-work';
  writeFileSync(process.env.WINNOW_CONFIG_PATH, `
accounts:
  - email: me@example.com
    channel: CDEFAULT
  - email: work@example.com
    slack:
      channel_id: CWORK
      bot_token_env: WORK_SLACK_BOT_TOKEN
      app_token_env: WORK_SLACK_APP_TOKEN
slack:
  channel_id: CFALLBACK
  feed_mode: all
`, 'utf8');
  reloadConfig();
});

describe('AI model routing', () => {
  it('uses separate durable defaults for classification and the assistant', () => {
    assert.equal(DEFAULT_CLASSIFICATION_MODEL, 'gemini-3.1-flash-lite');
    assert.equal(DEFAULT_ASSISTANT_MODEL, 'gemini-3.5-flash');
    assert.equal(getClassificationModelName({}), 'gemini-3.1-flash-lite');
    assert.equal(getAssistantModelName({}), 'gemini-3.5-flash');
  });

  it('allows each model path to be overridden independently', () => {
    const config = {
      model: {
        classification_name: 'classification-test-model',
        assistant_name: 'assistant-test-model',
      },
    };
    assert.equal(getClassificationModelName(config), 'classification-test-model');
    assert.equal(getAssistantModelName(config), 'assistant-test-model');
  });

  it('supports the legacy shared name as a backwards-compatible fallback', () => {
    const legacy = { model: { name: 'legacy-shared-model' } };
    assert.equal(getClassificationModelName(legacy), 'legacy-shared-model');
    assert.equal(getAssistantModelName(legacy), 'legacy-shared-model');
  });

  it('prefers path-specific names over the legacy shared fallback', () => {
    const config = {
      model: {
        name: 'legacy-shared-model',
        classification_name: 'classification-test-model',
        assistant_name: 'assistant-test-model',
      },
    };
    assert.equal(getClassificationModelName(config), 'classification-test-model');
    assert.equal(getAssistantModelName(config), 'assistant-test-model');
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WINNOW_CONFIG_PATH;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.WORK_SLACK_BOT_TOKEN;
  delete process.env.WORK_SLACK_APP_TOKEN;
});

describe('Slack routing config', () => {
  it('uses account-specific Slack credentials when configured', () => {
    assert.deepEqual(getSlackRoutingForAccount('work@example.com'), {
      account: 'work@example.com',
      channelId: 'CWORK',
      botToken: 'xoxb-work',
      appToken: 'xapp-work',
    });
  });

  it('falls back to global Slack credentials for ordinary accounts', () => {
    assert.deepEqual(getSlackRoutingForAccount('me@example.com'), {
      account: 'me@example.com',
      channelId: 'CDEFAULT',
      botToken: 'xoxb-default',
      appToken: 'xapp-default',
    });
  });

  it('deduplicates Socket Mode listener configs by Slack token pair', () => {
    const routes = getSlackActionRoutings();
    assert.equal(routes.length, 2);
    assert.deepEqual(routes.map(route => route.channelId).sort(), ['CFALLBACK', 'CWORK']);
  });

  it('does not pair an account-specific bot token with the global app token', () => {
    delete process.env.WORK_SLACK_APP_TOKEN;

    const route = getSlackRoutingForAccount('work@example.com');
    assert.equal(route.botToken, 'xoxb-work');
    assert.equal(route.appToken, null);

    const actionRoutes = getSlackActionRoutings();
    assert.equal(actionRoutes.length, 1);
    assert.equal(actionRoutes[0].botToken, 'xoxb-default');
  });
});

describe('scan query config', () => {
  it('uses the configured scan search query', () => {
    writeFileSync(process.env.WINNOW_CONFIG_PATH, `
accounts:
  - email: me@example.com
scan:
  search_query: in:inbox is:unread newer_than:3d
`, 'utf8');
    const config = reloadConfig();

    assert.equal(getScanSearchQuery(config), 'in:inbox is:unread newer_than:3d');
  });

  it('defaults to the broad unread inbox query when scan config is missing', () => {
    assert.equal(getScanSearchQuery({}), 'in:inbox is:unread newer_than:1d');
  });
});
