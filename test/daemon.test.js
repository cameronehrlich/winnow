import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolveDaemonIntervals } from '../src/daemon.js';

const require = createRequire(import.meta.url);

describe('daemon interval resolution', () => {
  it('uses configured daemon scan interval when CLI interval is omitted', () => {
    assert.deepEqual(resolveDaemonIntervals({}, {
      daemon: { scan_interval_seconds: 45 },
      reconcile: { interval_seconds: 600 },
    }), {
      scanIntervalSec: 45,
      reconcileIntervalSec: 600,
    });
  });

  it('lets explicit CLI interval override config', () => {
    assert.equal(resolveDaemonIntervals({ interval: 10 }, {
      daemon: { scan_interval_seconds: 45 },
    }).scanIntervalSec, 10);
  });

  it('falls back to safe defaults for invalid intervals', () => {
    assert.deepEqual(resolveDaemonIntervals({ interval: Number.NaN }, {
      daemon: { scan_interval_seconds: 0 },
      reconcile: { interval_seconds: -1 },
    }), {
      scanIntervalSec: 30,
      reconcileIntervalSec: 300,
    });
  });

  it('lets PM2 use the configured daemon scan interval', () => {
    const ecosystem = require('../ecosystem.config.cjs');
    const winnow = ecosystem.apps.find(app => app.name === 'winnow-watch');

    assert.equal(winnow.args, 'daemon');
  });
});
