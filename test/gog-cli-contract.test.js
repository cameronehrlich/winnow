import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { GogAdapter, GmailCommandError } from '../src/adapters/gog.js';

const exec = promisify(execFile);
const installed = spawnSync('gog', ['--version']);

describe('installed gog outbound parser contract', { skip: installed.error?.code === 'ENOENT' }, () => {
  // Synthetic addresses only. Dry-run avoids authentication/API calls; readonly
  // also prevents mutation if the CLI's dry-run behavior ever regresses.
  const adapter = new GogAdapter({ execute: (command, args, options) => (
    exec(command, [...args, '--dry-run', '--readonly'], options)
  ) });

  for (const text of ['---------- Forwarded message ---------\nFrom: Test', '--flag-looking text', '- a list item', 'Quotes " and = signs\nSecond line']) {
    it(`preserves arbitrary forward text (${text.slice(0, 20)})`, async () => {
      const result = await adapter.forward('sender@example.com', { messageId: 'safe-message' }, {
        to: ['recipient@example.com'], from: 'sender@example.com', note: text,
      });
      assert.equal(result.dry_run, true);
      assert.equal(result.op, 'gmail.forward');
      assert.equal(result.request.note_len, Buffer.byteLength(text));
    });

    it(`preserves arbitrary reply text (${text.slice(0, 20)})`, async () => {
      const result = await adapter.reply('sender@example.com', { messageId: 'safe-message' }, {
        to: ['recipient@example.com'], body: text, subject: '--subject-with-dashes',
      });
      assert.equal(result.dry_run, true);
      assert.equal(result.op, 'gmail.reply');
      assert.equal(result.request.body_len, Buffer.byteLength(text));
      assert.equal(result.request.subject_override, '--subject-with-dashes');
    });
  }
});

describe('outbound error privacy and retry semantics', () => {
  for (const [exitCode, code] of [[2, 'gmail_command_invalid'], [1, 'gmail_send_unconfirmed'], ['ETIMEDOUT', 'gmail_send_unconfirmed']]) {
    it(`sanitizes ${exitCode} without retaining email content`, async () => {
      const adapter = new GogAdapter({ execute: async () => {
        throw Object.assign(new Error('PRIVATE email echoed in command'), { code: exitCode, stderr: 'PRIVATE email body' });
      } });
      await assert.rejects(adapter.forward('sender@example.com', { messageId: 'message' }, {
        to: ['recipient@example.com'], note: 'hello',
      }), error => {
        assert.ok(error instanceof GmailCommandError);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /PRIVATE/);
        assert.equal(error.stderr, undefined);
        if (exitCode !== 2) assert.match(error.message, /Check Sent/);
        return true;
      });
    });
  }
});
