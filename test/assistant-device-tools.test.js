import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateAssistantToolCall } from '../src/assistant-tools.js';

describe('assistant device tools', () => {
  it('accepts an editable reminder without inventing a due date', () => {
    assert.deepEqual(validateAssistantToolCall('device.create_reminder', {
      title: 'Submit Wild Child receipt for FSA reimbursement',
      notes: 'Receipt forwarded by Riley.',
    }), {
      title: 'Submit Wild Child receipt for FSA reimbursement',
      notes: 'Receipt forwarded by Riley.',
      dueAt: '',
    });
  });

  it('requires a defensible calendar interval', () => {
    assert.throws(() => validateAssistantToolCall('device.create_calendar_event', {
      title: 'Appointment', startAt: 'not-a-date', endAt: '2026-07-14T11:00:00-07:00',
    }), /ISO 8601/);
    assert.throws(() => validateAssistantToolCall('device.create_calendar_event', {
      title: 'Appointment', startAt: '2026-07-14T12:00:00-07:00', endAt: '2026-07-14T11:00:00-07:00',
    }), /after startAt/);
  });

  it('limits contact picker proposals to explicit forwarding', () => {
    assert.deepEqual(validateAssistantToolCall('device.pick_contact', {
      name: 'Riley', action: 'forward',
    }), { name: 'Riley', action: 'forward' });
    assert.throws(() => validateAssistantToolCall('device.pick_contact', {
      name: 'Riley', action: 'reply',
    }), /only supports forward/);
  });
});
