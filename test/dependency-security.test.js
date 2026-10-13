import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import yaml from 'js-yaml';
import { WebClient } from '@slack/web-api';

it('preserves ordinary YAML anchors, merges and explicit overrides', () => {
  const config = yaml.load(`
defaults: &defaults
  read_only: false
  sync_enabled: true
accounts:
  - <<: *defaults
    email: support@example.com
    read_only: true
`);
  assert.deepEqual(config.accounts, [{
    read_only: true, sync_enabled: true, email: 'support@example.com',
  }]);
});

it('bounds repeated empty YAML merge sources with the default security budget', () => {
  // Empty mappings must consume merge work too. This small deterministic
  // fixture catches the old bypass without timing assertions or a costly DoS.
  const emptySources = Array(100).fill('{}').join(', ');
  const document = `sources: &sources [${emptySources}]\ntargets:\n`
    + '  - <<: *sources\n'.repeat(101);
  assert.throws(() => yaml.load(document), /merge keys exceeded maxTotalMergeKeys/);
});

it('keeps the Slack SDK transport compatible with the patched transitive axios', async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, team_id: 'TTEST', user_id: 'UTEST' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });

  // A local fixture only: no real token, external Slack request or mutation.
  const client = new WebClient('xoxb-unit-test', {
    slackApiUrl: `http://127.0.0.1:${server.address().port}/api/`,
    timeout: 5000,
    retryConfig: { retries: 0 },
  });
  const result = await client.apiCall('auth.test', { probe: 'dependency-upgrade' });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/api/auth.test');
  assert.equal(requests[0].headers.authorization, 'Bearer xoxb-unit-test');
  assert.equal(new URLSearchParams(requests[0].body).get('probe'), 'dependency-upgrade');
});
