import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGeminiClient, getVertexClientOptions } from '../src/gemini-client.js';

const originalEnv = Object.fromEntries(
  ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'WINNOW_VERTEX_API_KEY_FILE']
    .map(name => [name, process.env[name]]),
);
let tempDir;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'winnow-vertex-key-'));
  process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
  process.env.GOOGLE_CLOUD_LOCATION = 'global';
});

after(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

it('uses project-scoped Vertex AI with ADC when no key file is configured', () => {
  delete process.env.WINNOW_VERTEX_API_KEY_FILE;
  assert.deepEqual(getVertexClientOptions(), {
    vertexai: true,
    project: 'test-project',
    location: 'global',
  });
});

it('loads a Vertex AI key from a private file and passes it to the SDK', () => {
  const keyPath = join(tempDir, 'vertex-api-key');
  writeFileSync(keyPath, 'test-api-key\n', { mode: 0o600 });
  process.env.WINNOW_VERTEX_API_KEY_FILE = keyPath;
  assert.deepEqual(getVertexClientOptions(), {
    vertexai: true,
    project: 'test-project',
    location: 'global',
    apiKey: 'test-api-key',
  });
  assert.equal(getGeminiClient().apiClient.getApiKey(), 'test-api-key');
});

it('fails closed when a configured key file is empty or missing', () => {
  const keyPath = join(tempDir, 'empty-api-key');
  writeFileSync(keyPath, ' \n', { mode: 0o600 });
  process.env.WINNOW_VERTEX_API_KEY_FILE = keyPath;
  assert.throws(() => getVertexClientOptions(), /WINNOW_VERTEX_API_KEY_FILE is empty/);
  process.env.WINNOW_VERTEX_API_KEY_FILE = join(tempDir, 'missing-api-key');
  assert.throws(() => getVertexClientOptions(), { code: 'ENOENT' });
});

it('rejects a key file readable by other users', () => {
  const keyPath = join(tempDir, 'exposed-api-key');
  writeFileSync(keyPath, 'test-api-key\n', { mode: 0o600 });
  chmodSync(keyPath, 0o644);
  process.env.WINNOW_VERTEX_API_KEY_FILE = keyPath;
  assert.throws(() => getVertexClientOptions(), /must not be readable by other users/);
});
