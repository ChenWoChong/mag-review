import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeGatewayAttachments } from './t3-image-markup.js';
import { isPiCompactionSummary, isPiSummarization } from './pi-context.js';

const { Database } = process.versions.bun
  ? await import('bun:sqlite')
  : await import('node:sqlite').then(({ DatabaseSync }) => ({ Database: DatabaseSync }));

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

const schema = `
CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, scope TEXT, agent TEXT, protocol TEXT NOT NULL,
  origin TEXT NOT NULL, kind TEXT, result TEXT NOT NULL, signature TEXT,
  host_request_id TEXT
);
CREATE INDEX IF NOT EXISTS captures_signature ON captures(scope, signature);
CREATE TABLE IF NOT EXISTS sessions (scope TEXT PRIMARY KEY, history TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capture_prompts (
  capture_id TEXT NOT NULL REFERENCES captures(id), prompt_id TEXT NOT NULL REFERENCES prompts(id),
  PRIMARY KEY (capture_id, prompt_id)
);
CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
`;

export function withStore(directory, operation) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'gateway-diary.sqlite');
  closeSync(openSync(path, 'a', 0o600));
  const db = new Database(path);
  try {
    db.exec('PRAGMA busy_timeout = 150; PRAGMA foreign_keys = ON;');
    const mode = Object.values(db.prepare('PRAGMA journal_mode').get())[0];
    if (mode !== 'wal') db.exec('PRAGMA journal_mode = WAL;');
    db.exec(schema);
    return operation(db);
  } finally { db.close(); }
}

export function captureRequest(directory, event, classify) {
  return withStore(directory, db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const id = randomUUID();
      const prior = event.scope ? db.prepare('SELECT history FROM sessions WHERE scope = ?').get(event.scope) : null;
      const seen = event.scope && event.signature && db.prepare('SELECT 1 FROM captures WHERE scope = ? AND signature = ? AND result <> ? LIMIT 1').get(event.scope, event.signature, 'replayed_or_ambiguous');
      const decision = classify(prior, Boolean(seen));
      db.prepare('INSERT INTO captures VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, event.at, event.scope, event.agent, event.protocol, event.origin, event.kind, decision.result, event.signature, event.hostRequestId,
      );
      if (decision.history && event.scope) db.prepare(`INSERT INTO sessions VALUES (?, ?)
        ON CONFLICT(scope) DO UPDATE SET history = excluded.history`).run(event.scope, JSON.stringify(decision.history));
      const addPrompt = db.prepare('INSERT INTO prompts VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
      const addImage = db.prepare('INSERT INTO images VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
      const link = db.prepare('INSERT OR IGNORE INTO capture_prompts VALUES (?, ?)');
      const findPrompt = db.prepare('SELECT 1 FROM prompts WHERE id = ?');
      for (const { item, evidence, provenance, existingOnly } of decision.items) {
        const promptId = event.scope && item.id ? digest(JSON.stringify([event.scope, item.id])) : digest(`${id}:${item.position}`);
        if (existingOnly) {
          if (findPrompt.get(promptId)) link.run(id, promptId);
          continue;
        }
        const attachments = item.images.map(({ bytes: _bytes, ...image }) => image);
        const record = { id: promptId, source: 'magpie', session: event.scope, submittedAt: event.at,
          text: item.text, cwd: event.cwd, agent: event.agent, attachments, evidence, provenance };
        const written = addPrompt.run(promptId, JSON.stringify(record));
        if (written.changes) for (const image of item.images) addImage.run(image.id, image.bytes);
        link.run(id, promptId);
      }
      db.exec('COMMIT');
      return decision.result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export async function readSubmissions(directory) {
  return withStore(directory, db => {
    try {
      return db.prepare('SELECT record FROM prompts').all().flatMap(row => {
        const record = JSON.parse(row.record);
        if (record.agent === 'pi' && (isPiSummarization(record.text) || isPiCompactionSummary(record.text))) return [];
        return [{ ...record, ...normalizeGatewayAttachments(record.text, record.attachments) }];
      });
    } catch (error) { throw new Error('Cannot read diary records', { cause: error }); }
  });
}

export function readImages(directory, attachments) {
  return withStore(directory, db => {
    const query = db.prepare('SELECT bytes FROM images WHERE id = ?');
    return attachments.flatMap(({ id, mimeType }) => {
      if (!/^image\/(?:png|jpeg|gif|webp)$/.test(mimeType)) return [];
      const image = query.get(id);
      return image ? [{ id, src: `data:${mimeType};base64,${Buffer.from(image.bytes).toString('base64')}` }] : [];
    });
  });
}

export function verifyStore(directory) {
  return withStore(directory, db => ({
    integrity: Object.values(db.prepare('PRAGMA quick_check').get())[0],
    foreignKeyErrors: db.prepare('PRAGMA foreign_key_check').all().length,
    missingCapture: db.prepare('SELECT count(*) AS n FROM prompts p WHERE NOT EXISTS (SELECT 1 FROM capture_prompts c WHERE c.prompt_id = p.id)').get().n,
    prompts: db.prepare('SELECT count(*) AS n FROM prompts').get().n,
    observations: db.prepare('SELECT result, count(*) AS count FROM captures GROUP BY result ORDER BY result').all(),
  }));
}
