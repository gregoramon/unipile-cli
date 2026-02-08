import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";
import type { Message } from "./types.js";

const INBOX_DB_FILE = "inbox.db";
const CURSOR_OVERLAP_MS = 1000;

interface SqlRunResult {
  changes?: number | bigint;
}

interface SqlStatement {
  run(...values: unknown[]): SqlRunResult;
  get(...values: unknown[]): unknown;
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqlDatabase;
}

export interface InboxScopeDescriptor {
  profileName: string;
  accountId: string;
  chatIds: string[];
  senderId?: string;
  customStateKey?: string;
}

export interface PersistedMessageResult {
  isNewForScope: boolean;
  isNewInStore: boolean;
}

/**
 * Lazily loads node:sqlite to avoid startup warnings for non-inbox commands.
 */
async function loadSqliteModule(): Promise<SqliteModule> {
  try {
    const importer = new Function("specifier", "return import(specifier);") as (
      specifier: string
    ) => Promise<unknown>;

    const moduleObject = (await importer("node:sqlite")) as Partial<SqliteModule>;
    if (moduleObject && typeof moduleObject.DatabaseSync === "function") {
      return moduleObject as SqliteModule;
    }
  } catch {
    // fall through to the explicit runtime guidance below.
  }

  throw new Error(
    "SQLite state storage requires Node runtime support for node:sqlite. " +
      "Upgrade Node or run inbox commands with --no-state."
  );
}

/**
 * Resolves the sqlite file path used for inbox cursors, dedupe, and payload history.
 */
export function getInboxStatePath(): string {
  return join(getConfigDir(), INBOX_DB_FILE);
}

/**
 * Normalizes chat ids to a stable, deduplicated, sorted array.
 */
export function normalizeChatIds(chatIds: string[]): string[] {
  return Array.from(
    new Set(
      chatIds
        .map((chatId) => chatId.trim())
        .filter((chatId) => chatId.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));
}

/**
 * Builds a stable key for one inbox polling scope.
 */
export function buildInboxScopeKey(scope: InboxScopeDescriptor): string {
  const custom = scope.customStateKey?.trim();
  if (custom && custom.length > 0) {
    return `${scope.profileName}|${custom}`;
  }

  const chatScope = scope.chatIds.length > 0 ? scope.chatIds.join(",") : "*";
  const senderScope = scope.senderId?.trim() || "*";
  return `${scope.profileName}|${scope.accountId}|chat=${chatScope}|sender=${senderScope}`;
}

/**
 * Computes the next persisted cursor with a small overlap to avoid boundary misses.
 */
export function computeNextSinceCursor(
  currentSince: string | undefined,
  timestamps: Array<string | null | undefined>
): string | undefined {
  const candidates = timestamps
    .map((value) => {
      if (!value || value.trim().length === 0) {
        return null;
      }
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : parsed;
    })
    .filter((value): value is number => value !== null);

  const current = currentSince ? Date.parse(currentSince) : Number.NaN;
  if (!Number.isNaN(current)) {
    candidates.push(current);
  }

  if (candidates.length === 0) {
    return currentSince;
  }

  const newest = Math.max(...candidates);
  const overlapped = Math.max(0, newest - CURSOR_OVERLAP_MS);
  return new Date(overlapped).toISOString();
}

/**
 * Creates an inbox state store backed by the local sqlite file.
 */
export async function createInboxStateStore(path: string = getInboxStatePath()): Promise<InboxStateStore> {
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  const sqlite = await loadSqliteModule();
  const db = new sqlite.DatabaseSync(path);
  return new InboxStateStore(db);
}

/**
 * Persists inbox cursor state and message payload history for idempotent polling.
 */
export class InboxStateStore {
  private readonly db: SqlDatabase;
  private readonly selectCursorStmt;
  private readonly upsertScopeStmt;
  private readonly deleteScopeStmt;
  private readonly deleteScopeSeenStmt;
  private readonly insertMessageStmt;
  private readonly updateMessageStmt;
  private readonly insertScopeSeenStmt;

  public constructor(db: SqlDatabase) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watch_scope_state (
        scope_key TEXT PRIMARY KEY,
        profile_name TEXT NOT NULL,
        account_id TEXT NOT NULL,
        chat_ids TEXT NOT NULL,
        sender_id TEXT,
        since_cursor TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbox_message_store (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        chat_id TEXT,
        sender_id TEXT,
        timestamp TEXT,
        payload_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (account_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS scope_message_seen (
        scope_key TEXT NOT NULL,
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, account_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_scope_message_seen_scope_seen_at
      ON scope_message_seen(scope_key, seen_at);

      CREATE INDEX IF NOT EXISTS idx_inbox_message_store_timestamp
      ON inbox_message_store(timestamp);
    `);

    this.selectCursorStmt = this.db.prepare(`
      SELECT since_cursor
      FROM watch_scope_state
      WHERE scope_key = ?
      LIMIT 1
    `);

    this.upsertScopeStmt = this.db.prepare(`
      INSERT INTO watch_scope_state (
        scope_key,
        profile_name,
        account_id,
        chat_ids,
        sender_id,
        since_cursor,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        profile_name = excluded.profile_name,
        account_id = excluded.account_id,
        chat_ids = excluded.chat_ids,
        sender_id = excluded.sender_id,
        since_cursor = excluded.since_cursor,
        updated_at = excluded.updated_at
    `);

    this.deleteScopeStmt = this.db.prepare(`
      DELETE FROM watch_scope_state
      WHERE scope_key = ?
    `);

    this.deleteScopeSeenStmt = this.db.prepare(`
      DELETE FROM scope_message_seen
      WHERE scope_key = ?
    `);

    this.insertMessageStmt = this.db.prepare(`
      INSERT OR IGNORE INTO inbox_message_store (
        account_id,
        message_id,
        chat_id,
        sender_id,
        timestamp,
        payload_json,
        first_seen_at,
        last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateMessageStmt = this.db.prepare(`
      UPDATE inbox_message_store
      SET chat_id = ?, sender_id = ?, timestamp = ?, payload_json = ?, last_seen_at = ?
      WHERE account_id = ? AND message_id = ?
    `);

    this.insertScopeSeenStmt = this.db.prepare(`
      INSERT OR IGNORE INTO scope_message_seen (
        scope_key,
        account_id,
        message_id,
        seen_at
      ) VALUES (?, ?, ?, ?)
    `);
  }

  /**
   * Reads the last stored cursor for one scope key.
   */
  public getCursor(scopeKey: string): string | null {
    const row = this.selectCursorStmt.get(scopeKey) as
      | { since_cursor: string | null }
      | undefined;
    return row?.since_cursor ?? null;
  }

  /**
   * Creates or updates one scope row with the latest cursor.
   */
  public upsertScopeState(args: {
    scopeKey: string;
    profileName: string;
    accountId: string;
    chatIds: string[];
    senderId?: string;
    sinceCursor?: string;
  }): void {
    this.upsertScopeStmt.run(
      args.scopeKey,
      args.profileName,
      args.accountId,
      JSON.stringify(args.chatIds),
      args.senderId ?? null,
      args.sinceCursor ?? null,
      new Date().toISOString()
    );
  }

  /**
   * Clears cursor and seen-message state for one scope.
   */
  public resetScope(scopeKey: string): void {
    this.deleteScopeSeenStmt.run(scopeKey);
    this.deleteScopeStmt.run(scopeKey);
  }

  /**
   * Stores a message payload and marks first-seen state for one scope.
   */
  public persistMessage(scopeKey: string, message: Message): PersistedMessageResult {
    const now = new Date().toISOString();
    const insertedMessage = this.insertMessageStmt.run(
      message.account_id,
      message.id,
      message.chat_id ?? null,
      message.sender_id ?? null,
      message.timestamp ?? null,
      JSON.stringify(message),
      now,
      now
    );

    const isNewInStore = Number(insertedMessage.changes ?? 0) > 0;
    if (!isNewInStore) {
      this.updateMessageStmt.run(
        message.chat_id ?? null,
        message.sender_id ?? null,
        message.timestamp ?? null,
        JSON.stringify(message),
        now,
        message.account_id,
        message.id
      );
    }

    const insertedSeen = this.insertScopeSeenStmt.run(
      scopeKey,
      message.account_id,
      message.id,
      now
    );

    return {
      isNewForScope: Number(insertedSeen.changes ?? 0) > 0,
      isNewInStore
    };
  }

  /**
   * Closes the sqlite connection.
   */
  public close(): void {
    this.db.close();
  }
}
