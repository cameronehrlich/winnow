import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReadableAttachment,
  planReadableAttachmentBatch,
} from '../src/email-attachments.js';

function attachment(index, mimeType = 'image/jpeg', sizeBytes = 100) {
  return {
    messageId: 'message-1',
    attachmentId: `attachment-${index}`,
    filename: `scan-${index}.jpg`,
    mimeType,
    sizeBytes,
  };
}

describe('assistant attachment planning', () => {
  it('accepts Gemini-compatible image types and PDFs while rejecting unsupported files', () => {
    for (const mimeType of [
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    ]) {
      assert.equal(assertReadableAttachment(attachment(mimeType, mimeType)).mimeType, mimeType);
    }
    assert.throws(
      () => assertReadableAttachment(attachment('svg', 'image/svg+xml')),
      error => error.code === 'attachment_type_not_supported',
    );
  });

  it('selects four related JPEGs in one bounded batch with the requested image first', () => {
    const images = [1, 2, 3, 4].map(index => attachment(index));
    const plan = planReadableAttachmentBatch(images[2], images);
    assert.deepEqual(plan.selected.map(item => item.attachmentId), [
      'attachment-3', 'attachment-1', 'attachment-2', 'attachment-4',
    ]);
    assert.equal(plan.totalBytes, 400);
    assert.deepEqual(plan.omitted, {
      unsupportedType: 0, unsupportedSize: 0, itemLimit: 0, byteBudget: 0,
    });
  });

  it('uses aggregate byte and item budgets while continuing past unsuitable siblings', () => {
    const requested = attachment('requested', 'image/jpeg', 100);
    const candidates = [
      requested,
      attachment('unsupported', 'image/svg+xml', 50),
      attachment('too-large', 'image/png', 11 * 1024 * 1024),
      attachment('budget', 'image/png', 200),
      attachment('fits', 'image/png', 100),
      attachment('item-limit', 'image/png', 100),
    ];
    const plan = planReadableAttachmentBatch(requested, candidates, { maxBytes: 250, maxItems: 2 });
    assert.deepEqual(plan.selected.map(item => item.attachmentId), [
      'attachment-requested', 'attachment-fits',
    ]);
    assert.deepEqual(plan.omitted, {
      unsupportedType: 1, unsupportedSize: 1, itemLimit: 1, byteBudget: 1,
    });
  });
});
