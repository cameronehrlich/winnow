import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDaemonIntervals } from '../src/daemon.js';

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
});
