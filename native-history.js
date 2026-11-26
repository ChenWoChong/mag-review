import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, openReadOnlyDatabase } from './sqlite.js';

const filename = 'native-history.sqlite';

export function readNativeHistory(directory) {
  const path = join(directory, filename);
  if (!existsSync(path)) return [];
  const db = openReadOnlyDatabase(path);
  try {
    return db.prepare('SELECT record FROM native_prompts').all().map(({ record }) => JSON.parse(record));
  } finally { db.close(); }
}

export function hasNativeHistory(directory) {
  const path = join(directory, filename);
  if (!existsSync(path)) return false;
  const db = openReadOnlyDatabase(path);
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_prompts'").get());
  } finally { db.close(); }
}

export function publishNativeHistory(directory, records) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, filename);
  closeSync(openSync(path, 'a', 0o600));
  const db = openDatabase(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS native_prompts (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
      const insert = db.prepare('INSERT INTO native_prompts VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
      let added = 0;
      for (const record of records) added += Number(insert.run(record.id, JSON.stringify(record)).changes);
      db.exec('COMMIT');
      return added;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally { db.close(); }
}
