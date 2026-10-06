import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, username TEXT, name TEXT NOT NULL,
      course INTEGER, program TEXT, group_id TEXT, notifications TEXT NOT NULL DEFAULT 'new',
      reachable INTEGER NOT NULL DEFAULT 1, session TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admins (
      user_id INTEGER PRIMARY KEY, group_id TEXT UNIQUE,
      reminders TEXT NOT NULL DEFAULT 'weekly', granted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, due_date TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active', created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_group_date ON tasks(group_id, state, due_date);
    CREATE INDEX IF NOT EXISTS users_group ON users(group_id, notifications, reachable);
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
      user_id INTEGER, method TEXT NOT NULL, payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT, failed INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0, lease_owner TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS processed_updates (id INTEGER PRIMARY KEY, processed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER NOT NULL,
      action TEXT NOT NULL, task_id INTEGER, data TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `;

export function openDatabase(path = process.env.DATABASE_PATH || './data/bot.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  const columns = db.prepare('PRAGMA table_info(outbox)').all().map(c => c.name);
  if (!columns.includes('lease_until')) db.exec('ALTER TABLE outbox ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0');
  if (!columns.includes('lease_owner')) db.exec('ALTER TABLE outbox ADD COLUMN lease_owner TEXT');
  return db;
}

export async function transaction(db, fn) {
  if (db.transaction) return db.transaction(fn);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
