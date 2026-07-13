import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(__dirname, '..', 'data', 'winnow.db');
const LEGACY_STATE_PATH = join(__dirname, '..', 'data', 'state.json');
const LA_TIME_ZONE = 'America/Los_Angeles';
const EVENT_JOIN_SELECT = `
  e.id AS event_id,
  e.event_type AS event_type,
  e.source AS event_source,
  e.account AS event_account,
  e.email_item_id AS event_email_item_id,
  e.gmail_message_id AS event_gmail_message_id,
  e.gmail_thread_id AS event_gmail_thread_id,
  e.timestamp AS event_timestamp,
  e.reason AS event_reason,
  e.metadata_json AS event_metadata_json,
  i.id AS item_id,
  i.account AS item_account,
  i.gmail_message_id AS item_gmail_message_id,
  i.gmail_thread_id AS item_gmail_thread_id,
  i.from_name AS item_from_name,
  i.from_email AS item_from_email,
  i.subject AS item_subject,
  i.snippet AS item_snippet,
  i.summary AS item_summary,
  i.action AS item_action,
  i.deadline AS item_deadline,
  i.impact AS item_impact,
  i.handling AS item_handling,
  i.reason AS item_reason,
  i.confidence AS item_confidence,
  i.ephemeral AS item_ephemeral,
  i.low_confidence_kept AS item_low_confidence_kept,
  i.triage_state AS item_triage_state,
  i.mailbox_state AS item_mailbox_state,
  i.read_state AS item_read_state,
  i.unsubscribe_url AS item_unsubscribe_url,
  i.created_at AS item_created_at,
  i.processed_at AS item_processed_at,
  i.updated_at AS item_updated_at
`;

let db;
let dbPath = process.env.WINNOW_DB_PATH || DEFAULT_DB_PATH;
export const storeEvents = new EventEmitter();

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value) {
  return JSON.stringify(value || {});
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getDb() {
  if (db) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate();
  importLegacyStateOnce();
  return db;
}

export function configureDatabaseForTests(path) {
  if (db) {
    db.close();
    db = null;
  }
  dbPath = path;
}

export function closeStoreForTests() {
  if (db) {
    db.close();
    db = null;
  }
}

function migrate() {
  const database = db;
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_items (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      gmail_message_id TEXT,
      gmail_thread_id TEXT,
      from_name TEXT,
      from_email TEXT,
      subject TEXT,
      snippet TEXT,
      summary TEXT,
      action TEXT,
      deadline TEXT,
      impact TEXT,
      handling TEXT,
      reason TEXT,
      confidence INTEGER,
      ephemeral INTEGER NOT NULL DEFAULT 0,
      low_confidence_kept INTEGER NOT NULL DEFAULT 0,
      triage_state TEXT NOT NULL DEFAULT 'kept',
      mailbox_state TEXT NOT NULL DEFAULT 'unknown',
      read_state TEXT NOT NULL DEFAULT 'unknown',
      unsubscribe_url TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(account, gmail_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_email_items_account_processed
      ON email_items(account, processed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_items_thread
      ON email_items(account, gmail_thread_id);
    CREATE INDEX IF NOT EXISTS idx_email_items_mailbox
      ON email_items(mailbox_state, processed_at DESC);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      account TEXT,
      email_item_id TEXT,
      gmail_message_id TEXT,
      gmail_thread_id TEXT,
      timestamp TEXT NOT NULL,
      reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(email_item_id) REFERENCES email_items(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_email ON events(email_item_id, id);

    CREATE TABLE IF NOT EXISTS delivery_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_item_id TEXT NOT NULL,
      sink TEXT NOT NULL,
      channel_id TEXT,
      message_ts TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'sent',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(email_item_id) REFERENCES email_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_email_sink
      ON delivery_records(email_item_id, sink);

    DELETE FROM delivery_records
    WHERE sink = 'slack'
      AND id NOT IN (
        SELECT MAX(id)
        FROM delivery_records
        WHERE sink = 'slack'
        GROUP BY email_item_id, sink
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_slack_email_sink_unique
      ON delivery_records(email_item_id, sink)
      WHERE sink = 'slack';

    CREATE TABLE IF NOT EXISTS push_devices (
      id TEXT PRIMARY KEY,
      device_token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL DEFAULT 'ios',
      installation_id TEXT,
      environment TEXT NOT NULL DEFAULT 'production',
      bundle_id TEXT,
      app_version TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      last_success_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_conversations (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('email', 'mailbox')),
      account TEXT,
      email_item_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(email_item_id) REFERENCES email_items(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_conversations_updated
      ON assistant_conversations(updated_at DESC);

    CREATE TABLE IF NOT EXISTS assistant_email_conversations (
      email_item_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE,
      FOREIGN KEY(email_item_id) REFERENCES email_items(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE
    );

    INSERT INTO assistant_email_conversations (email_item_id, conversation_id)
    SELECT conversation.email_item_id, conversation.id
    FROM assistant_conversations conversation
    WHERE conversation.scope = 'email'
      AND conversation.email_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM assistant_conversations newer
        WHERE newer.scope = 'email'
          AND newer.email_item_id = conversation.email_item_id
          AND (
            newer.updated_at > conversation.updated_at
            OR (newer.updated_at = conversation.updated_at AND newer.rowid > conversation.rowid)
          )
      )
    ON CONFLICT(email_item_id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS assistant_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      text TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      draft_json TEXT,
      proposal_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation
      ON assistant_messages(conversation_id, created_at, id);

    CREATE TABLE IF NOT EXISTS assistant_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
      idempotency_key TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE,
      UNIQUE(conversation_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_runs_conversation
      ON assistant_runs(conversation_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS assistant_proposals (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      risk TEXT NOT NULL CHECK(risk IN ('reversible', 'persistent', 'outbound')),
      summary TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      confirmation_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'executing', 'completed', 'cancelled', 'expired', 'failed')),
      expires_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(run_id) REFERENCES assistant_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_proposals_conversation
      ON assistant_proposals(conversation_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS assistant_tool_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      proposal_id TEXT,
      tool TEXT NOT NULL,
      risk TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      result_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('started', 'proposed', 'completed', 'failed')),
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(run_id) REFERENCES assistant_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(proposal_id) REFERENCES assistant_proposals(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_rules (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      effect TEXT NOT NULL CHECK(effect IN ('archive', 'keep')),
      matcher_kind TEXT NOT NULL CHECK(matcher_kind IN ('sender', 'domain', 'list_id')),
      matcher_value TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      source_email_item_id TEXT,
      created_by TEXT NOT NULL DEFAULT 'assistant',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(source_email_item_id) REFERENCES email_items(id) ON DELETE SET NULL,
      UNIQUE(account, effect, matcher_kind, matcher_value)
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_rules_account_enabled
      ON assistant_rules(account, enabled, created_at);

    CREATE TABLE IF NOT EXISTS user_rules (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      rule_type TEXT NOT NULL CHECK(rule_type IN ('exact', 'semantic')),
      effect TEXT NOT NULL CHECK(effect IN ('archive', 'keep')),
      match_text TEXT,
      matcher_kind TEXT CHECK(matcher_kind IS NULL OR matcher_kind IN ('sender', 'domain', 'list_id')),
      matcher_value TEXT,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL CHECK(source IN ('assistant', 'api', 'import')),
      baseline_rule_id TEXT,
      source_email_item_id TEXT,
      conflict_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(source_email_item_id) REFERENCES email_items(id) ON DELETE SET NULL,
      UNIQUE(account, conflict_key)
    );

    CREATE INDEX IF NOT EXISTS idx_user_rules_account_enabled
      ON user_rules(account, enabled, updated_at DESC);

    INSERT OR IGNORE INTO user_rules (
      id, account, rule_type, effect, matcher_kind, matcher_value, description,
      enabled, source, source_email_item_id, conflict_key, created_at, updated_at
    )
    SELECT
      id, account, 'exact', effect, matcher_kind, matcher_value, description,
      enabled, CASE WHEN created_by = 'assistant' THEN 'assistant' ELSE 'import' END,
      source_email_item_id, 'exact:' || matcher_kind || ':' || lower(matcher_value),
      created_at, updated_at
    FROM assistant_rules
    WHERE NOT EXISTS (
      SELECT 1 FROM meta WHERE key = 'assistant_rules_to_user_rules_v1'
    )
    ORDER BY updated_at DESC, id DESC;

    INSERT INTO meta (key, value)
    VALUES ('assistant_rules_to_user_rules_v1', 'complete')
    ON CONFLICT(key) DO NOTHING;
  `);

  // Older personal databases predate native-client read state. This additive
  // migration lets a normal daemon restart upgrade them in place.
  const emailColumns = database.prepare('PRAGMA table_info(email_items)').all();
  if (!emailColumns.some(column => column.name === 'read_state')) {
    database.exec("ALTER TABLE email_items ADD COLUMN read_state TEXT NOT NULL DEFAULT 'unknown'");
  }
  const pushColumns = database.prepare('PRAGMA table_info(push_devices)').all();
  for (const [name, definition] of [
    ['installation_id', 'TEXT'],
    ['environment', "TEXT NOT NULL DEFAULT 'production'"],
    ['bundle_id', 'TEXT'],
    ['last_error', 'TEXT'],
    ['last_success_at', 'TEXT'],
  ]) {
    if (!pushColumns.some(column => column.name === name)) {
      database.exec(`ALTER TABLE push_devices ADD COLUMN ${name} ${definition}`);
    }
  }
}

function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value || null;
}

function setMeta(key, value) {
  getDb().prepare(`
    INSERT INTO meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function makeEmailItemId(account, messageId = '', threadId = '') {
  return Buffer.from(`${account || ''}\0${messageId || ''}\0${threadId || ''}`).toString('base64url');
}

function splitSender(from) {
  const raw = String(from || '').trim();
  const match = raw.match(/^"?([^"<]+)"?\s*<([^>]+)>/);
  if (match) return { fromName: match[1].trim(), fromEmail: match[2].trim() };
  const emailMatch = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) return { fromName: raw.replace(emailMatch[0], '').trim() || emailMatch[0].split('@')[0], fromEmail: emailMatch[0] };
  return { fromName: raw || 'Unknown', fromEmail: '' };
}

export function resultToEmailItem(result, opts = {}) {
  const account = opts.account || result.account || '';
  const messageId = opts.messageId || result.messageId || '';
  const threadId = opts.threadId || result.threadId || '';
  const id = opts.id || result.emailItemId || makeEmailItemId(account, messageId, threadId);
  const sender = splitSender(result.from);
  const archived = Boolean(result.archive);
  const triageState = opts.triageState || (archived ? 'auto_archived' : 'kept');
  const mailboxState = opts.mailboxState || (archived ? 'archived' : 'inbox');
  const requestedReadState = opts.readState || result.readState;
  const readState = ['read', 'unread', 'unknown'].includes(requestedReadState)
    ? requestedReadState
    : (archived ? 'read' : 'unknown');
  const confidence = Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null;
  const lowConfidenceKept = !archived && confidence !== null && confidence < 70;
  const timestamp = opts.timestamp || result.processedAt || nowIso();

  return {
    id,
    account,
    gmailMessageId: messageId || null,
    gmailThreadId: threadId || null,
    fromName: sender.fromName,
    fromEmail: sender.fromEmail,
    subject: result.subject || '(no subject)',
    snippet: result.snippet || '',
    summary: result.summary || '',
    action: result.action || '',
    deadline: result.deadline || '',
    impact: result.impact || '',
    handling: result.handling || '',
    reason: result.reason || '',
    confidence,
    ephemeral: result.ephemeral ? 1 : 0,
    lowConfidenceKept: lowConfidenceKept ? 1 : 0,
    triageState,
    mailboxState,
    readState,
    unsubscribeUrl: result.unsubscribeLink || result.unsubscribe_url || '',
    createdAt: timestamp,
    processedAt: timestamp,
    updatedAt: nowIso(),
  };
}

function rowToEmailItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    account: row.account,
    messageId: row.gmail_message_id || '',
    threadId: row.gmail_thread_id || '',
    fromName: row.from_name || '',
    fromEmail: row.from_email || '',
    from: row.from_email ? `${row.from_name || row.from_email} <${row.from_email}>` : (row.from_name || ''),
    subject: row.subject || '(no subject)',
    snippet: row.snippet || '',
    summary: row.summary || '',
    action: row.action || '',
    deadline: row.deadline || '',
    impact: row.impact || '',
    handling: row.handling || '',
    reason: row.reason || '',
    confidence: row.confidence,
    ephemeral: Boolean(row.ephemeral),
    lowConfidenceKept: Boolean(row.low_confidence_kept),
    triageState: row.triage_state,
    mailboxState: row.mailbox_state,
    readState: row.read_state || 'unknown',
    isRead: row.read_state === 'read' ? true : row.read_state === 'unread' ? false : null,
    archive: row.mailbox_state === 'archived' || row.triage_state === 'auto_archived' || row.triage_state === 'manual_archived',
    unsubscribeLink: row.unsubscribe_url || '',
    createdAt: row.created_at,
    processedAt: row.processed_at,
    updatedAt: row.updated_at,
  };
}

export function upsertEmailItem(item) {
  const database = getDb();
  database.prepare(`
    INSERT INTO email_items (
      id, account, gmail_message_id, gmail_thread_id, from_name, from_email, subject, snippet,
      summary, action, deadline, impact, handling, reason, confidence, ephemeral, low_confidence_kept,
      triage_state, mailbox_state, read_state, unsubscribe_url, created_at, processed_at, updated_at
    )
    VALUES (
      @id, @account, @gmailMessageId, @gmailThreadId, @fromName, @fromEmail, @subject, @snippet,
      @summary, @action, @deadline, @impact, @handling, @reason, @confidence, @ephemeral, @lowConfidenceKept,
      @triageState, @mailboxState, @readState, @unsubscribeUrl, @createdAt, @processedAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      gmail_message_id = COALESCE(excluded.gmail_message_id, email_items.gmail_message_id),
      gmail_thread_id = COALESCE(excluded.gmail_thread_id, email_items.gmail_thread_id),
      from_name = excluded.from_name,
      from_email = excluded.from_email,
      subject = excluded.subject,
      snippet = excluded.snippet,
      summary = excluded.summary,
      action = excluded.action,
      deadline = excluded.deadline,
      impact = excluded.impact,
      handling = excluded.handling,
      reason = excluded.reason,
      confidence = excluded.confidence,
      ephemeral = excluded.ephemeral,
      low_confidence_kept = excluded.low_confidence_kept,
      triage_state = excluded.triage_state,
      mailbox_state = excluded.mailbox_state,
      read_state = excluded.read_state,
      unsubscribe_url = excluded.unsubscribe_url,
      processed_at = COALESCE(excluded.processed_at, email_items.processed_at),
      updated_at = excluded.updated_at
  `).run(item);
  return getEmailItem(item.id);
}

export function upsertEmailItemFromResult(result, opts = {}) {
  return upsertEmailItem(resultToEmailItem(result, opts));
}

export function getEmailItem(id) {
  return rowToEmailItem(getDb().prepare('SELECT * FROM email_items WHERE id = ?').get(id));
}

export function findEmailItemByGmail({ account, messageId, threadId }) {
  const database = getDb();
  const row = messageId
    ? database.prepare('SELECT * FROM email_items WHERE account = ? AND gmail_message_id = ?').get(account, messageId)
    : database.prepare('SELECT * FROM email_items WHERE account = ? AND gmail_thread_id = ? ORDER BY processed_at DESC LIMIT 1').get(account, threadId);
  return rowToEmailItem(row);
}

export function updateEmailItemState(id, { triageState, mailboxState, readState, reason } = {}) {
  const existing = getEmailItem(id);
  if (!existing) return null;
  const normalizedReadState = ['read', 'unread', 'unknown'].includes(readState)
    ? readState
    : existing.readState;
  const updates = {
    id,
    triageState: triageState || existing.triageState,
    mailboxState: mailboxState || existing.mailboxState,
    readState: normalizedReadState,
    reason: reason || existing.reason,
    updatedAt: nowIso(),
  };
  getDb().prepare(`
    UPDATE email_items
    SET triage_state = @triageState, mailbox_state = @mailboxState, read_state = @readState,
        reason = @reason, updated_at = @updatedAt
    WHERE id = @id
  `).run(updates);
  return getEmailItem(id);
}

export function listEmailItems({ state = 'all', account = '', cursor = '', limit = 50 } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const filters = [];
  const params = {};

  if (account) {
    filters.push('account = @account');
    params.account = account;
  }
  if (state === 'inbox') filters.push("mailbox_state = 'inbox'");
  else if (state === 'archived') filters.push("mailbox_state = 'archived'");
  if (cursor) {
    filters.push('processed_at < @cursor');
    params.cursor = cursor;
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = getDb().prepare(`
    SELECT * FROM email_items
    ${where}
    ORDER BY processed_at DESC, id DESC
    LIMIT @limit
  `).all({ ...params, limit: boundedLimit + 1 });

  const hasMore = rows.length > boundedLimit;
  const pageRows = hasMore ? rows.slice(0, boundedLimit) : rows;
  const items = pageRows.map(rowToEmailItem);
  return {
    items,
    nextCursor: hasMore ? items.at(-1)?.processedAt || null : null,
  };
}

export function listRecentTrackedEmailItems({ account = '', days = 7, limit = 100 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const params = { cutoff, limit };
  const accountSql = account ? 'AND account = @account' : '';
  if (account) params.account = account;
  return getDb().prepare(`
    SELECT * FROM email_items
    WHERE processed_at >= @cutoff
      AND gmail_message_id IS NOT NULL
      AND gmail_message_id != ''
      ${accountSql}
    ORDER BY processed_at DESC
    LIMIT @limit
  `).all(params).map(rowToEmailItem);
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.event_id,
    eventType: row.event_type,
    source: row.event_source,
    account: row.event_account || '',
    emailItemId: row.event_email_item_id || '',
    messageId: row.event_gmail_message_id || '',
    threadId: row.event_gmail_thread_id || '',
    timestamp: row.event_timestamp,
    reason: row.event_reason || '',
    metadata: parseJson(row.event_metadata_json),
    email: row.item_id ? rowToEmailItem({
      id: row.item_id,
      account: row.item_account,
      gmail_message_id: row.item_gmail_message_id,
      gmail_thread_id: row.item_gmail_thread_id,
      from_name: row.item_from_name,
      from_email: row.item_from_email,
      subject: row.item_subject,
      snippet: row.item_snippet,
      summary: row.item_summary,
      action: row.item_action,
      deadline: row.item_deadline,
      impact: row.item_impact,
      handling: row.item_handling,
      reason: row.item_reason,
      confidence: row.item_confidence,
      ephemeral: row.item_ephemeral,
      low_confidence_kept: row.item_low_confidence_kept,
      triage_state: row.item_triage_state,
      mailbox_state: row.item_mailbox_state,
      read_state: row.item_read_state,
      unsubscribe_url: row.item_unsubscribe_url,
      created_at: row.item_created_at,
      processed_at: row.item_processed_at,
      updated_at: row.item_updated_at,
    }) : null,
  };
}

export function appendEvent({
  eventType,
  source = 'system',
  account = '',
  emailItemId = '',
  messageId = '',
  threadId = '',
  reason = '',
  metadata = {},
  timestamp = nowIso(),
}) {
  const result = getDb().prepare(`
    INSERT INTO events (
      event_type, source, account, email_item_id, gmail_message_id, gmail_thread_id, timestamp, reason, metadata_json
    )
    VALUES (@eventType, @source, @account, @emailItemId, @messageId, @threadId, @timestamp, @reason, @metadataJson)
  `).run({
    eventType,
    source,
    account,
    emailItemId: emailItemId || null,
    messageId: messageId || null,
    threadId: threadId || null,
    timestamp,
    reason,
    metadataJson: safeJson(metadata),
  });
  const event = getEvent(Number(result.lastInsertRowid));
  storeEvents.emit('event', event);
  return event;
}

export function appendEmailEvent(eventType, item, opts = {}) {
  return appendEvent({
    eventType,
    source: opts.source || 'scan',
    account: opts.account || item?.account || '',
    emailItemId: opts.emailItemId || item?.id || '',
    messageId: opts.messageId || item?.messageId || '',
    threadId: opts.threadId || item?.threadId || '',
    reason: opts.reason || item?.reason || '',
    metadata: opts.metadata || {},
    timestamp: opts.timestamp,
  });
}

export function getEvent(id) {
  const row = getDb().prepare(`
    SELECT ${EVENT_JOIN_SELECT}
    FROM events e
    LEFT JOIN email_items i ON i.id = e.email_item_id
    WHERE e.id = ?
  `).get(id);
  return rowToEvent(row);
}

export function listEvents({ since = 0, limit = 100 } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return getDb().prepare(`
    SELECT ${EVENT_JOIN_SELECT}
    FROM events e
    LEFT JOIN email_items i ON i.id = e.email_item_id
    WHERE e.id > @since
    ORDER BY e.id ASC
    LIMIT @limit
  `).all({ since: Number(since) || 0, limit: boundedLimit }).map(rowToEvent);
}

export function getLatestEventsByAccount({ accounts = [], eventTypes = [] } = {}) {
  const result = {};
  const typeClause = eventTypes.length
    ? `AND e.event_type IN (${eventTypes.map(() => '?').join(', ')})`
    : '';
  const sql = `
    SELECT ${EVENT_JOIN_SELECT}
    FROM events e
    LEFT JOIN email_items i ON i.id = e.email_item_id
    WHERE e.account = ?
      ${typeClause}
    ORDER BY e.id DESC
    LIMIT 1
  `;
  const stmt = getDb().prepare(sql);

  for (const account of accounts) {
    const row = stmt.get(account, ...eventTypes);
    result[account] = rowToEvent(row);
  }

  return result;
}

export function recordDelivery({
  emailItemId,
  sink,
  channelId = '',
  messageTs = '',
  deliveryState = 'sent',
  metadata = {},
}) {
  const timestamp = nowIso();
  const params = {
    emailItemId,
    sink,
    channelId,
    messageTs,
    deliveryState,
    timestamp,
    metadataJson: safeJson(metadata),
  };

  if (sink === 'slack') {
    getDb().prepare(`
      INSERT INTO delivery_records (
        email_item_id, sink, channel_id, message_ts, delivery_state, created_at, updated_at, metadata_json
      )
      VALUES (@emailItemId, @sink, @channelId, @messageTs, @deliveryState, @timestamp, @timestamp, @metadataJson)
      ON CONFLICT(email_item_id, sink) WHERE sink = 'slack' DO UPDATE SET
        channel_id = excluded.channel_id,
        message_ts = excluded.message_ts,
        delivery_state = excluded.delivery_state,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(params);
    return listDeliveryRecords(emailItemId, sink)[0];
  }

  const result = getDb().prepare(`
    INSERT INTO delivery_records (
      email_item_id, sink, channel_id, message_ts, delivery_state, created_at, updated_at, metadata_json
    )
    VALUES (@emailItemId, @sink, @channelId, @messageTs, @deliveryState, @timestamp, @timestamp, @metadataJson)
  `).run(params);
  return { id: Number(result.lastInsertRowid), emailItemId, sink, channelId, messageTs, deliveryState };
}

export function listDeliveryRecords(emailItemId, sink = '') {
  const sql = sink
    ? 'SELECT * FROM delivery_records WHERE email_item_id = ? AND sink = ? ORDER BY id DESC'
    : 'SELECT * FROM delivery_records WHERE email_item_id = ? ORDER BY id DESC';
  const rows = sink ? getDb().prepare(sql).all(emailItemId, sink) : getDb().prepare(sql).all(emailItemId);
  return rows.map(row => ({
    id: row.id,
    emailItemId: row.email_item_id,
    sink: row.sink,
    channelId: row.channel_id || '',
    messageTs: row.message_ts || '',
    deliveryState: row.delivery_state,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function registerPushDevice({
  deviceToken,
  platform = 'ios',
  installationId = '',
  environment = 'production',
  bundleId = '',
  appVersion = '',
}) {
  const stableKey = installationId || deviceToken;
  const id = Buffer.from(`${platform}\0${stableKey}`).toString('base64url');
  const timestamp = nowIso();
  getDb().prepare('DELETE FROM push_devices WHERE device_token = ? AND id != ?').run(deviceToken, id);
  getDb().prepare(`
    INSERT INTO push_devices (
      id, device_token, platform, installation_id, environment, bundle_id,
      app_version, enabled, last_error, created_at, updated_at
    )
    VALUES (
      @id, @deviceToken, @platform, @installationId, @environment, @bundleId,
      @appVersion, 1, NULL, @timestamp, @timestamp
    )
    ON CONFLICT(id) DO UPDATE SET
      device_token = excluded.device_token,
      platform = excluded.platform,
      installation_id = excluded.installation_id,
      environment = excluded.environment,
      bundle_id = excluded.bundle_id,
      app_version = excluded.app_version,
      enabled = 1,
      last_error = NULL,
      updated_at = excluded.updated_at
  `).run({ id, deviceToken, platform, installationId, environment, bundleId, appVersion, timestamp });
  return { id, platform, installationId, environment, bundleId, appVersion, enabled: true };
}

export function deletePushDevice(id) {
  const result = getDb().prepare('UPDATE push_devices SET enabled = 0, updated_at = ? WHERE id = ?').run(nowIso(), id);
  return result.changes > 0;
}

export function disablePushDevice(id, error = '') {
  const result = getDb().prepare(`
    UPDATE push_devices SET enabled = 0, last_error = ?, updated_at = ? WHERE id = ?
  `).run(error, nowIso(), id);
  return result.changes > 0;
}

export function recordPushDelivery(id, result) {
  const success = Boolean(result?.ok);
  getDb().prepare(`
    UPDATE push_devices SET
      last_error = @lastError,
      last_success_at = CASE WHEN @success = 1 THEN @timestamp ELSE last_success_at END,
      updated_at = @timestamp
    WHERE id = @id
  `).run({
    id,
    success: success ? 1 : 0,
    lastError: success ? null : String(result?.reason || `APNs ${result?.status || 'error'}`),
    timestamp: nowIso(),
  });
}

export function listPushDevices() {
  return getDb().prepare('SELECT * FROM push_devices WHERE enabled = 1 ORDER BY updated_at DESC').all().map(row => ({
    id: row.id,
    deviceToken: row.device_token,
    platform: row.platform,
    installationId: row.installation_id || '',
    environment: row.environment || 'production',
    bundleId: row.bundle_id || '',
    appVersion: row.app_version || '',
    enabled: Boolean(row.enabled),
    lastError: row.last_error || '',
    lastSuccessAt: row.last_success_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getMailboxCounts() {
  const rows = getDb().prepare(`
    SELECT mailbox_state, COUNT(*) AS count
    FROM email_items
    WHERE mailbox_state IN ('inbox', 'archived')
    GROUP BY mailbox_state
  `).all();
  const counts = { inbox: 0, archived: 0 };
  for (const row of rows) counts[row.mailbox_state] = Number(row.count);
  return counts;
}

export function setSyncState(key, value) {
  getDb().prepare(`
    INSERT INTO sync_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), nowIso());
}

export function getSyncState(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return row ? parseJson(row.value, fallback) : fallback;
}

function localDateString(dateLike, timeZone = LA_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(dateLike));
  const get = (type) => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function summaryItem(event) {
  const email = event.email || {};
  return {
    eventId: event.id,
    emailItemId: event.emailItemId || email.id || '',
    timestamp: event.timestamp,
    account: event.account,
    threadId: event.threadId || email.threadId || '',
    messageId: event.messageId || email.messageId || '',
    from: email.from || '',
    subject: email.subject || '',
    summary: email.summary || '',
    actionType: event.eventType,
    source: event.source,
    reason: event.reason || email.reason || '',
    confidence: email.confidence,
  };
}

function listActionSummaryEvents({ account = '', date = '', timeZone = LA_TIME_ZONE } = {}) {
  return getDb().prepare(`
    SELECT ${EVENT_JOIN_SELECT}
    FROM events e
    LEFT JOIN email_items i ON i.id = e.email_item_id
    ORDER BY e.id ASC
  `).all().map(rowToEvent).filter(event => {
    if (account && event.account !== account) return false;
    return !date || localDateString(event.timestamp, timeZone) === date;
  });
}

function summarizeActionEvents(events, { date, account, timeZone }) {
  const summary = {
    date,
    timeZone,
    account: account || 'all',
    counters: {
      processed: 0,
      kept: 0,
      autoArchived: 0,
      manualArchived: 0,
      restoredToInbox: 0,
      unsubscribedSucceeded: 0,
      unsubscribedFailed: 0,
      unsubscribedAttempted: 0,
      ephemeral: 0,
      lowConfidenceKept: 0,
    },
    lists: {
      actedOn: [],
      archived: [],
      kept: [],
      restored: [],
      unsubscribed: [],
    },
  };

  const seenActedOn = new Set();
  for (const event of events) {
    const item = summaryItem(event);
    if (!seenActedOn.has(event.id)) {
      summary.lists.actedOn.push(item);
      seenActedOn.add(event.id);
    }

    if (event.eventType === 'email.scanned') summary.counters.processed++;
    if (event.eventType === 'email.kept') {
      summary.counters.kept++;
      summary.lists.kept.push(item);
      if (event.email?.lowConfidenceKept) summary.counters.lowConfidenceKept++;
    }
    if (event.eventType === 'email.auto_archived') {
      summary.counters.autoArchived++;
      summary.lists.archived.push(item);
      if (event.email?.ephemeral) summary.counters.ephemeral++;
    }
    if (event.eventType === 'email.manual_archived') {
      summary.counters.manualArchived++;
      summary.lists.archived.push(item);
    }
    if (event.eventType === 'email.restored_to_inbox') {
      summary.counters.restoredToInbox++;
      summary.lists.restored.push(item);
    }
    if (event.eventType === 'email.unsubscribed') {
      summary.counters.unsubscribedSucceeded++;
      summary.lists.unsubscribed.push(item);
    }
    if (event.eventType === 'email.unsubscribe_failed') {
      summary.counters.unsubscribedFailed++;
      summary.lists.unsubscribed.push(item);
    }
    if (event.eventType === 'email.unsubscribe_attempted') {
      summary.counters.unsubscribedAttempted++;
      summary.lists.unsubscribed.push(item);
    }
  }

  return summary;
}

export function getDailyActionSummary({ date = localDateString(Date.now()), account = '', timeZone = LA_TIME_ZONE } = {}) {
  const events = listActionSummaryEvents({ account, date, timeZone });
  return summarizeActionEvents(events, { date, account, timeZone });
}

export function getLifetimeActionSummary({ account = '', timeZone = LA_TIME_ZONE, recentLimit = 25 } = {}) {
  const boundedRecentLimit = Math.min(Math.max(Number(recentLimit) || 25, 1), 100);
  const events = listActionSummaryEvents({ account, timeZone });
  const summary = summarizeActionEvents(events, { date: 'lifetime', account, timeZone });
  const recentActivityTypes = new Set([
    'email.kept',
    'email.auto_archived',
    'email.manual_archived',
    'email.restored_to_inbox',
    'email.unsubscribed',
    'email.unsubscribe_attempted',
    'email.unsubscribe_failed',
  ]);
  return {
    scope: 'lifetime',
    timeZone,
    account: account || 'all',
    counters: summary.counters,
    recentActivity: summary.lists.actedOn
      .filter(item => recentActivityTypes.has(item.actionType))
      .slice(-boundedRecentLimit)
      .reverse(),
  };
}

function rowToAssistantConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    account: row.account || null,
    emailItemId: row.email_item_id || null,
    title: row.title || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeAssistantEvidence(evidence = []) {
  if (!Array.isArray(evidence)) return [];
  const clip = (value, max) => String(value || '').slice(0, max);
  return evidence.slice(0, 25).map(item => ({
    account: clip(item?.account, 320),
    messageId: clip(item?.messageId || item?.id, 300),
    threadId: clip(item?.threadId, 300),
    subject: clip(item?.subject, 500),
    from: clip(item?.from, 500),
    date: clip(item?.date, 100),
    snippet: clip(item?.snippet, 500),
  }));
}

function rowToAssistantProposal(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    tool: row.tool,
    risk: row.risk,
    summary: row.summary,
    arguments: parseJson(row.arguments_json),
    confirmationDigest: row.confirmation_digest,
    status: row.status,
    expiresAt: row.expires_at,
    result: parseJson(row.result_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAssistantMessage(row) {
  if (!row) return null;
  const message = {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    text: row.text,
    createdAt: row.created_at,
  };
  const evidence = parseJson(row.evidence_json, []);
  if (evidence.length) message.evidence = evidence;
  const draft = parseJson(row.draft_json, null);
  if (draft) message.draft = draft;
  if (row.proposal_id) {
    message.proposal = row.proposal_tool ? rowToAssistantProposal({
      id: row.proposal_id,
      conversation_id: row.proposal_conversation_id,
      run_id: row.proposal_run_id,
      tool: row.proposal_tool,
      risk: row.proposal_risk,
      summary: row.proposal_summary,
      arguments_json: row.proposal_arguments_json,
      confirmation_digest: row.proposal_confirmation_digest,
      status: row.proposal_status,
      expires_at: row.proposal_expires_at,
      result_json: row.proposal_result_json,
      created_at: row.proposal_created_at,
      updated_at: row.proposal_updated_at,
    }) : { id: row.proposal_id };
  }
  return message;
}

const ASSISTANT_MESSAGE_SELECT = `
  m.*,
  p.conversation_id AS proposal_conversation_id,
  p.run_id AS proposal_run_id,
  p.tool AS proposal_tool,
  p.risk AS proposal_risk,
  p.summary AS proposal_summary,
  p.arguments_json AS proposal_arguments_json,
  p.confirmation_digest AS proposal_confirmation_digest,
  p.status AS proposal_status,
  p.expires_at AS proposal_expires_at,
  p.result_json AS proposal_result_json,
  p.created_at AS proposal_created_at,
  p.updated_at AS proposal_updated_at
`;

export function createAssistantConversation({ id, scope, account = '', emailItemId = '', title = '' }) {
  const timestamp = nowIso();
  getDb().prepare(`
    INSERT INTO assistant_conversations (id, scope, account, email_item_id, title, created_at, updated_at)
    VALUES (@id, @scope, @account, @emailItemId, @title, @createdAt, @updatedAt)
  `).run({
    id,
    scope,
    account: account || null,
    emailItemId: emailItemId || null,
    title: String(title || '').slice(0, 300),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return getAssistantConversation(id);
}

export function getOrCreateAssistantEmailConversation({ id, account, emailItemId, title = '' }) {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    let conversation = rowToAssistantConversation(database.prepare(`
      SELECT conversation.*
      FROM assistant_email_conversations canonical
      JOIN assistant_conversations conversation ON conversation.id = canonical.conversation_id
      WHERE canonical.email_item_id = ?
    `).get(emailItemId));

    if (!conversation) {
      conversation = rowToAssistantConversation(database.prepare(`
        SELECT *
        FROM assistant_conversations
        WHERE scope = 'email' AND email_item_id = ?
        ORDER BY updated_at DESC, rowid DESC
        LIMIT 1
      `).get(emailItemId));
    }

    if (!conversation) {
      const timestamp = nowIso();
      database.prepare(`
        INSERT INTO assistant_conversations (id, scope, account, email_item_id, title, created_at, updated_at)
        VALUES (@id, 'email', @account, @emailItemId, @title, @createdAt, @updatedAt)
      `).run({
        id,
        account,
        emailItemId,
        title: String(title || '').slice(0, 300),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      conversation = getAssistantConversation(id);
    }

    database.prepare(`
      INSERT INTO assistant_email_conversations (email_item_id, conversation_id)
      VALUES (?, ?)
      ON CONFLICT(email_item_id) DO NOTHING
    `).run(emailItemId, conversation.id);
    database.exec('COMMIT');
    return conversation;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

export function getAssistantConversation(id) {
  return rowToAssistantConversation(
    getDb().prepare('SELECT * FROM assistant_conversations WHERE id = ?').get(id)
  );
}

export function addAssistantMessage({
  id, conversationId, role, text = '', evidence = [], draft = null,
  proposalId = '', createdAt = nowIso(),
}) {
  const database = getDb();
  database.prepare(`
    INSERT INTO assistant_messages (
      id, conversation_id, role, text, evidence_json, draft_json, proposal_id, created_at
    ) VALUES (
      @id, @conversationId, @role, @text, @evidenceJson, @draftJson, @proposalId, @createdAt
    )
  `).run({
    id,
    conversationId,
    role,
    text: String(text || '').slice(0, 12000),
    evidenceJson: JSON.stringify(sanitizeAssistantEvidence(evidence)),
    draftJson: draft ? JSON.stringify(draft) : null,
    proposalId: proposalId || null,
    createdAt,
  });
  database.prepare('UPDATE assistant_conversations SET updated_at = ? WHERE id = ?')
    .run(createdAt, conversationId);
  return getAssistantMessage(id);
}

export function getAssistantMessage(id) {
  return rowToAssistantMessage(getDb().prepare(`
    SELECT ${ASSISTANT_MESSAGE_SELECT}
    FROM assistant_messages m
    LEFT JOIN assistant_proposals p ON p.id = m.proposal_id
    WHERE m.id = ?
  `).get(id));
}

export function listAssistantMessages(conversationId, limit = 200) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  return getDb().prepare(`
    SELECT *
    FROM (
      SELECT ${ASSISTANT_MESSAGE_SELECT}, m.rowid AS message_rowid
      FROM assistant_messages m
      LEFT JOIN assistant_proposals p ON p.id = m.proposal_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at DESC, m.rowid DESC
      LIMIT ?
    ) recent
    ORDER BY created_at, message_rowid
  `).all(conversationId, boundedLimit).map(rowToAssistantMessage);
}

export function getAssistantConversationEnvelope(id) {
  const conversation = getAssistantConversation(id);
  if (!conversation) return null;
  return { conversation, messages: listAssistantMessages(id) };
}

export function createAssistantRun({ id, conversationId, userMessageId, idempotencyKey = '' }) {
  const timestamp = nowIso();
  const database = getDb();
  try {
    database.prepare(`
      INSERT INTO assistant_runs (
        id, conversation_id, user_message_id, status, idempotency_key, created_at
      ) VALUES (?, ?, ?, 'running', ?, ?)
    `).run(id, conversationId, userMessageId, idempotencyKey || null, timestamp);
    return { id, conversationId, userMessageId, status: 'running', idempotencyKey: idempotencyKey || null, createdAt: timestamp };
  } catch (err) {
    if (!idempotencyKey || !String(err.message).includes('UNIQUE constraint failed')) throw err;
    return getAssistantRunByIdempotencyKey(conversationId, idempotencyKey);
  }
}

export function getAssistantRunByIdempotencyKey(conversationId, idempotencyKey) {
  const row = getDb().prepare(`
    SELECT * FROM assistant_runs WHERE conversation_id = ? AND idempotency_key = ?
  `).get(conversationId, idempotencyKey);
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
  };
}

export function completeAssistantRun(id, { status = 'completed', errorCode = '' } = {}) {
  const completedAt = nowIso();
  getDb().prepare(`
    UPDATE assistant_runs SET status = ?, error_code = ?, completed_at = ? WHERE id = ?
  `).run(status, errorCode || null, completedAt, id);
}

export function createAssistantProposal({
  id, conversationId, runId, tool, risk, summary, arguments: args,
  confirmationDigest, expiresAt, idempotencyKey,
}) {
  const timestamp = nowIso();
  getDb().prepare(`
    INSERT INTO assistant_proposals (
      id, conversation_id, run_id, tool, risk, summary, arguments_json,
      confirmation_digest, status, expires_at, idempotency_key, created_at, updated_at
    ) VALUES (
      @id, @conversationId, @runId, @tool, @risk, @summary, @argumentsJson,
      @confirmationDigest, 'pending', @expiresAt, @idempotencyKey, @createdAt, @updatedAt
    )
  `).run({
    id,
    conversationId,
    runId,
    tool,
    risk,
    summary: String(summary || '').slice(0, 1000),
    argumentsJson: JSON.stringify(args || {}),
    confirmationDigest,
    expiresAt,
    idempotencyKey,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return getAssistantProposal(id);
}

export function getAssistantProposal(id) {
  return rowToAssistantProposal(
    getDb().prepare('SELECT * FROM assistant_proposals WHERE id = ?').get(id)
  );
}

export function claimAssistantProposal(id, confirmationDigest) {
  const database = getDb();
  const timestamp = nowIso();
  const result = database.prepare(`
    UPDATE assistant_proposals
    SET status = 'executing', updated_at = @timestamp
    WHERE id = @id
      AND confirmation_digest = @confirmationDigest
      AND status = 'pending'
      AND expires_at > @timestamp
  `).run({ id, confirmationDigest, timestamp });
  if (result.changes === 1) return { claimed: true, proposal: getAssistantProposal(id) };

  const proposal = getAssistantProposal(id);
  if (!proposal) return { claimed: false, reason: 'not_found', proposal: null };
  if (proposal.confirmationDigest !== confirmationDigest) return { claimed: false, reason: 'digest_mismatch', proposal };
  if (proposal.status !== 'pending') return { claimed: false, reason: proposal.status, proposal };
  database.prepare(`
    UPDATE assistant_proposals SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'
  `).run(timestamp, id);
  return { claimed: false, reason: 'expired', proposal: getAssistantProposal(id) };
}

export function finishAssistantProposal(id, { status, result = null }) {
  const timestamp = nowIso();
  getDb().prepare(`
    UPDATE assistant_proposals SET status = ?, result_json = ?, updated_at = ? WHERE id = ?
  `).run(status, result ? JSON.stringify(result) : null, timestamp, id);
  return getAssistantProposal(id);
}

export function cancelAssistantProposal(id) {
  const timestamp = nowIso();
  const result = getDb().prepare(`
    UPDATE assistant_proposals
    SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(timestamp, id);
  return { changed: result.changes === 1, proposal: getAssistantProposal(id) };
}

export function recordAssistantToolCall({
  id, runId, proposalId = '', tool, risk, arguments: args,
  result = null, status,
}) {
  const timestamp = nowIso();
  getDb().prepare(`
    INSERT INTO assistant_tool_calls (
      id, run_id, proposal_id, tool, risk, arguments_json, result_json, status, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, runId, proposalId || null, tool, risk, JSON.stringify(args || {}),
    result ? JSON.stringify(result) : null, status, timestamp,
    ['completed', 'failed', 'proposed'].includes(status) ? timestamp : null
  );
}

function rowToAssistantRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    account: row.account,
    effect: row.effect,
    matcherKind: row.matcher_kind,
    matcherValue: row.matcher_value,
    description: row.description || '',
    enabled: Boolean(row.enabled),
    sourceEmailItemId: row.source_email_item_id || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUserRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    account: row.account,
    type: row.rule_type,
    effect: row.effect,
    match: row.match_text || '',
    matcherKind: row.matcher_kind || null,
    matcherValue: row.matcher_value || null,
    description: row.description || '',
    enabled: Boolean(row.enabled),
    source: row.source,
    baselineRuleId: row.baseline_rule_id || null,
    sourceEmailItemId: row.source_email_item_id || null,
    conflictKey: row.conflict_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertUserRuleRecord({
  id,
  account,
  type,
  effect,
  match = '',
  matcherKind = null,
  matcherValue = null,
  description = '',
  enabled = true,
  source = 'api',
  baselineRuleId = null,
  sourceEmailItemId = null,
  conflictKey,
  createdAt = nowIso(),
  updatedAt = nowIso(),
}) {
  const database = getDb();
  database.prepare(`
    INSERT INTO user_rules (
      id, account, rule_type, effect, match_text, matcher_kind, matcher_value,
      description, enabled, source, baseline_rule_id, source_email_item_id,
      conflict_key, created_at, updated_at
    ) VALUES (
      @id, @account, @type, @effect, @match, @matcherKind, @matcherValue,
      @description, @enabled, @source, @baselineRuleId, @sourceEmailItemId,
      @conflictKey, @createdAt, @updatedAt
    )
    ON CONFLICT(account, conflict_key) DO UPDATE SET
      rule_type = excluded.rule_type,
      effect = excluded.effect,
      match_text = excluded.match_text,
      matcher_kind = excluded.matcher_kind,
      matcher_value = excluded.matcher_value,
      description = excluded.description,
      enabled = excluded.enabled,
      source = excluded.source,
      baseline_rule_id = excluded.baseline_rule_id,
      source_email_item_id = COALESCE(excluded.source_email_item_id, user_rules.source_email_item_id),
      updated_at = excluded.updated_at
  `).run({
    id,
    account,
    type,
    effect,
    match: match || null,
    matcherKind,
    matcherValue,
    description: String(description || '').slice(0, 1000),
    enabled: enabled ? 1 : 0,
    source,
    baselineRuleId,
    sourceEmailItemId,
    conflictKey,
    createdAt,
    updatedAt,
  });
  return rowToUserRule(database.prepare(`
    SELECT * FROM user_rules WHERE account = ? AND conflict_key = ?
  `).get(account, conflictKey));
}

export function getUserRuleRecord(id) {
  return rowToUserRule(getDb().prepare('SELECT * FROM user_rules WHERE id = ?').get(id));
}

export function listUserRuleRecords({ account = '', enabledOnly = false } = {}) {
  const filters = [];
  const params = {};
  if (account) {
    filters.push('account = @account');
    params.account = account;
  }
  if (enabledOnly) filters.push('enabled = 1');
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return getDb().prepare(`
    SELECT * FROM user_rules ${where} ORDER BY updated_at DESC, id DESC
  `).all(params).map(rowToUserRule);
}

export function setUserRuleEnabled(id, enabled) {
  getDb().prepare('UPDATE user_rules SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, nowIso(), id);
  return getUserRuleRecord(id);
}

export function deleteUserRuleRecord(id) {
  return getDb().prepare('DELETE FROM user_rules WHERE id = ?').run(id).changes === 1;
}

export function createAssistantRule({
  id,
  account,
  effect,
  matcherKind,
  matcherValue,
  description = '',
  enabled = true,
  sourceEmailItemId = '',
  createdBy = 'assistant',
}) {
  const rule = upsertUserRuleRecord({
    id,
    account,
    type: 'exact',
    effect,
    matcherKind,
    matcherValue,
    description,
    enabled,
    source: createdBy === 'assistant' ? 'assistant' : 'import',
    sourceEmailItemId: sourceEmailItemId || null,
    conflictKey: `exact:${matcherKind}:${String(matcherValue).toLowerCase()}`,
  });
  return { ...rule, createdBy };
}

export function getAssistantRule(id) {
  const rule = getUserRuleRecord(id);
  return rule?.type === 'exact' ? { ...rule, createdBy: rule.source } : null;
}

export function listAssistantRules({ account = '', enabledOnly = false } = {}) {
  return listUserRuleRecords({ account, enabledOnly })
    .filter(rule => rule.type === 'exact')
    .reverse()
    .map(rule => ({ ...rule, createdBy: rule.source }));
}

export function setAssistantRuleEnabled(id, enabled) {
  const rule = setUserRuleEnabled(id, enabled);
  return rule?.type === 'exact' ? { ...rule, createdBy: rule.source } : null;
}

function importLegacyStateOnce() {
  if (process.env.WINNOW_SKIP_LEGACY_IMPORT === '1') {
    setMeta('legacy_state_import_v1', 'done');
    return;
  }
  if (getMeta('legacy_state_import_v1') === 'done') return;
  if (!existsSync(LEGACY_STATE_PATH)) {
    setMeta('legacy_state_import_v1', 'done');
    return;
  }

  try {
    const legacy = JSON.parse(readFileSync(LEGACY_STATE_PATH, 'utf8'));
    const results = Array.isArray(legacy.scanResults) ? legacy.scanResults : [];
    const unsubscribes = legacy.stats?.unsubscribes?.entries || [];
    const database = getDb();
    database.exec('BEGIN');
    try {
      for (const result of results) {
        const item = upsertEmailItemFromResult(result, {
          messageId: result.messageId,
          threadId: result.threadId,
          account: result.account,
          timestamp: result.processedAt,
        });
        appendEmailEvent('email.scanned', item, { source: 'legacy_import', timestamp: result.processedAt, reason: result.reason });
        appendEmailEvent(result.archive ? 'email.auto_archived' : 'email.kept', item, {
          source: 'legacy_import',
          timestamp: result.processedAt,
          reason: result.reason,
        });
      }

      for (const entry of unsubscribes) {
        const existing = findEmailItemByGmail({ account: entry.account, threadId: entry.threadId });
        const eventType = entry.status === 'failed' ? 'email.unsubscribe_failed' : 'email.unsubscribed';
        appendEvent({
          eventType,
          source: entry.source || 'legacy_import',
          account: entry.account || existing?.account || '',
          emailItemId: existing?.id || '',
          messageId: existing?.messageId || '',
          threadId: entry.threadId || existing?.threadId || '',
          timestamp: entry.timestamp || nowIso(),
          reason: entry.note || entry.status || '',
          metadata: entry,
        });
      }
      setMeta('legacy_state_import_v1', 'done');
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error(`[winnow/store] Legacy state import failed: ${err.message}`);
    setMeta('legacy_state_import_v1', 'failed');
  }
}

export function ensureStore() {
  getDb();
  return { ok: true, path: dbPath };
}
