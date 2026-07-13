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
      app_version TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Older personal databases predate native-client read state. This additive
  // migration lets a normal daemon restart upgrade them in place.
  const emailColumns = database.prepare('PRAGMA table_info(email_items)').all();
  if (!emailColumns.some(column => column.name === 'read_state')) {
    database.exec("ALTER TABLE email_items ADD COLUMN read_state TEXT NOT NULL DEFAULT 'unknown'");
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

export function registerPushDevice({ deviceToken, platform = 'ios', appVersion = '' }) {
  const id = Buffer.from(`${platform}\0${deviceToken}`).toString('base64url');
  const timestamp = nowIso();
  getDb().prepare(`
    INSERT INTO push_devices (id, device_token, platform, app_version, enabled, created_at, updated_at)
    VALUES (@id, @deviceToken, @platform, @appVersion, 1, @timestamp, @timestamp)
    ON CONFLICT(device_token) DO UPDATE SET
      platform = excluded.platform,
      app_version = excluded.app_version,
      enabled = 1,
      updated_at = excluded.updated_at
  `).run({ id, deviceToken, platform, appVersion, timestamp });
  return { id, deviceToken, platform, appVersion, enabled: true };
}

export function deletePushDevice(id) {
  const result = getDb().prepare('UPDATE push_devices SET enabled = 0, updated_at = ? WHERE id = ?').run(nowIso(), id);
  return result.changes > 0;
}

export function listPushDevices() {
  return getDb().prepare('SELECT * FROM push_devices WHERE enabled = 1 ORDER BY updated_at DESC').all().map(row => ({
    id: row.id,
    deviceToken: row.device_token,
    platform: row.platform,
    appVersion: row.app_version || '',
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
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

export function getDailyActionSummary({ date = localDateString(Date.now()), account = '', timeZone = LA_TIME_ZONE } = {}) {
  const events = getDb().prepare(`
    SELECT ${EVENT_JOIN_SELECT}
    FROM events e
    LEFT JOIN email_items i ON i.id = e.email_item_id
    ORDER BY e.id ASC
  `).all().map(rowToEvent).filter(event => {
    if (account && event.account !== account) return false;
    return localDateString(event.timestamp, timeZone) === date;
  });

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
