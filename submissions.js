import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashText } from './identity.js';

const snapshotName = '.submissions.json';

export function submission({ source, session, messageId, submittedAt, text, cwd, projectRoot, agent, attachments = [] }) {
  if (!source || !session || !messageId || typeof text !== 'string' || (!text.trim() && !attachments.length)) return null;
  const time = Date.parse(submittedAt);
  if (!Number.isFinite(time)) return null;
  return {
    id: hashText(JSON.stringify([source, session, messageId])),
    source,
    session,
    messageId,
    submittedAt: new Date(time).toISOString(),
    text,
    cwd,
    projectRoot,
    agent,
    attachments,
  };
}

async function readSnapshot(directory) {
  try { return await readFile(join(directory, snapshotName), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
}

export async function readSubmissions(directory) {
  const text = await readSnapshot(directory);
  if (!text) return [];
  let snapshot;
  try { snapshot = JSON.parse(text); }
  catch (error) { throw new Error('Invalid submissions snapshot', { cause: error }); }
  if (snapshot.version !== 1 || !Array.isArray(snapshot.records)) throw new Error('Invalid submissions snapshot');
  return snapshot.records;
}

export async function writeSubmissions(directory, submissions) {
  const records = new Map(submissions.map(record => [record.id, record]));
  const text = JSON.stringify({ version: 1, records: [...records.values()] });
  if (text === await readSnapshot(directory)) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `.submissions-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 });
    await rename(temp, join(directory, snapshotName));
  } finally {
    await rm(temp, { force: true });
  }
}
