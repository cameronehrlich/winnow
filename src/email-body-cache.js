import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Disposable body cache, never mailbox-state authority. Keys include the mailbox
// because Gmail message IDs alone are not a cross-account identity.
export class EmailBodyCache {
  constructor({ directory = fileURLToPath(new URL('../data/email-body-cache-v1/', import.meta.url)),
    maxBytes = 64 * 1024 * 1024, maxEntries = 256, ttlMs = 24 * 60 * 60 * 1000,
    now = Date.now } = {}) {
    Object.assign(this, { directory, maxBytes, maxEntries, ttlMs, now });
    this.pending = new Map();
    this.pruning = Promise.resolve();
  }

  key(account, messageId, variant = 'source') {
    return createHash('sha256').update(JSON.stringify([account, messageId, variant])).digest('hex');
  }

  async read(key) {
    try {
      const path = join(this.directory, `${key}.json`);
      if ((await stat(path)).size > 16 * 1024 * 1024) return null;
      const entry = JSON.parse(await readFile(path, 'utf8'));
      if (!Number.isFinite(entry.savedAt) || this.now() - entry.savedAt > this.ttlMs) return null;
      return entry.value;
    } catch { return null; }
  }

  async write(key, value) {
    const data = JSON.stringify({ savedAt: this.now(), value });
    if (Buffer.byteLength(data) > Math.min(this.maxBytes, 16 * 1024 * 1024)) return;
    let temporary;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(this.directory, `${key}.json`));
      this.pruning = this.pruning.then(() => this.prune()).catch(() => {});
      await this.pruning;
    } catch { /* Cache failures must never prevent reading mail. */ }
    finally { if (temporary) await unlink(temporary).catch(() => {}); }
  }

  async remove(key) { await unlink(join(this.directory, `${key}.json`)).catch(() => {}); }

  async markMissing(account, messageId) {
    await this.write(this.key(account, messageId, 'missing'), { missing: true });
    await this.remove(this.key(account, messageId));
    await this.remove(this.key(account, messageId, 'images'));
  }

  async getOrLoad(key, loader, { refresh = false } = {}) {
    // Only provider reads are shared. A refresh must never join a disk hit.
    if (this.pending.has(key)) return this.pending.get(key);
    if (!refresh) {
      const cached = await this.read(key);
      if (this.pending.has(key)) return this.pending.get(key);
      if (cached) return cached;
    }
    const request = (async () => {
      const value = await loader();
      await this.write(key, value);
      return value;
    })();
    this.pending.set(key, request);
    try { return await request; } finally { this.pending.delete(key); }
  }

  async prune() {
    const files = await readdir(this.directory);
    const entries = (await Promise.all(files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
      try { const info = await stat(join(this.directory, name)); return { name, size: info.size, time: info.mtimeMs }; }
      catch { return null; }
    }))).filter(Boolean).sort((a, b) => b.time - a.time);
    let bytes = 0;
    for (const [index, entry] of entries.entries()) {
      bytes += entry.size;
      if (index >= this.maxEntries || bytes > this.maxBytes || this.now() - entry.time > this.ttlMs) {
        await unlink(join(this.directory, entry.name)).catch(() => {});
      }
    }
  }
}

export const emailBodyCache = new EmailBodyCache();
