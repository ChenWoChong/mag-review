import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { directoryFor } from './storage.js';
import * as zlib from 'node:zlib';
import { eventKey, hashText } from './identity.js';

const exec = promisify(execFile);
const childEnv = { ...process.env, MAGPIE_PROMPT_IMPORT_CHILD: '1' };
const fileName = '.history.json';

function contentOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => p && ['text', 'input_text'].includes(p.type) && typeof p.text === 'string').map(p => p.text).join('\n');
}

function uniqueTimes(source) {
  const counts = new Map();
  for (const message of source) counts.set(message.time, (counts.get(message.time) || 0) + 1);
  return counts;
}

export function sourceMessages(agent, raw) {
  const rows = raw.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  if (agent === 'pi') {
    // Pi keeps a tree; only the branch ending at its most recent entry is active.
    const entries = new Map(rows.filter(x => x.id && x.type !== 'session' && x.type !== 'title').map(x => [x.id, x]));
    let last = [...entries.keys()].at(-1), branch = [], seen = new Set();
    while (last && entries.has(last) && !seen.has(last)) {
      seen.add(last); const row = entries.get(last); branch.push(row); last = row.parentId;
    }
    rows.splice(0, rows.length, ...branch.reverse());
  }
  return rows.flatMap(row => {
    let message;
    if (agent === 'codex' && row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user') message = row.payload;
    if (agent === 'claude' && row.type === 'user' && !row.isMeta && !row.isSidechain && row.message?.role === 'user') message = row.message;
    if (agent === 'pi' && row.type === 'message' && row.message?.role === 'user') message = row.message;
    if (!message) return [];
    const time = row.timestamp || message.timestamp;
    const text = contentOf(message.content);
    if (!text.trim() || !time || Number.isNaN(Date.parse(time))) return [];
    return [{ time: new Date(time).toISOString(), text, event: row.uuid || row.id || row.payload?.id || '' }];
  });
}

export function matchMessages(session, transcript, source) {
  const times = uniqueTimes(source);
  const remaining = new Map();
  for (const p of transcript.parts || []) {
    if (p.role !== 'user' || p.kind !== 'text' || !p.text?.trim()) continue;
    const text = p.text.trim(); remaining.set(text, (remaining.get(text) || 0) + 1);
  }
  const entries = [];
  for (const msg of source) {
    const text = msg.text.trim();
    if (!remaining.get(text)) continue;
    remaining.set(text, remaining.get(text) - 1);
    if (/^Generate a title that will help the user recognize this T3 Code thread/.test(text)) continue;
    const id = createHash('sha256').update(JSON.stringify([session.agent, session.id, msg.event, msg.time, text])).digest('hex');
    entries.push({ id, time: msg.time, text: msg.text, agent: session.app || session.agent, cwd: session.cwd || '', session: session.id, nativeEvent: (msg.event || times.get(msg.time) === 1) ? eventKey(session.id, msg) : '' });
  }
  return entries;
}

async function acquire(directory) {
  const path = join(directory, '.history-import.lock');
  try { const f = await open(path, 'wx', 0o600); await f.writeFile(String(process.pid)); await f.close(); return path; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // A killed host can leave a lock. Only replace one whose process is gone.
    let pid; try { pid = Number(await readFile(path, 'utf8')); } catch { return null; }
    if (!Number.isInteger(pid) || pid < 1) return null;
    try { process.kill(pid, 0); return null; } catch (err) { if (err.code !== 'ESRCH') return null; }
    await rm(path, { force: true });
    try { const f = await open(path, 'wx', 0o600); await f.writeFile(String(process.pid)); await f.close(); return path; } catch { return null; }
  }
}

export async function importHistory(options = {}) {
  const directory = directoryFor(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await acquire(directory);
  if (!lock) return { busy: true };
  try {
    // Search warms Magpie's index and respects its session-read settings. The
    // word affects search hits, not which sessions are indexed.
    await exec('magpie', ['sessions', 'search', 'magpie', '--days', 'all', '--limit', '1', '--wait', '60s', '--json'], { env: childEnv, timeout: 70_000, maxBuffer: 5 * 1024 * 1024 });
    const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'magpie', 'said-v1.db');
    const { stdout } = await exec('sqlite3', ['-readonly', '-separator', '\t', cache, 'select key,path from files order by key'], { env: childEnv, maxBuffer: 20 * 1024 * 1024 });
    const refs = stdout.split('\n').filter(Boolean).map(line => line.split('\t'));
    let index = 0, read = 0, failed = 0, truncated = 0, unsupported = 0, unmatched = 0;
    const records = [], anchors = [], sources = {};
    async function worker() {
      while (index < refs.length) {
        const [ref, sourcePath] = refs[index++];
        const agent = ref.split(':', 1)[0];
        if (!['codex', 'claude', 'pi'].includes(agent)) { unsupported++; continue; }
        try {
          const { stdout: text } = await exec('magpie', ['sessions', 'show', ref, '--json'], { env: childEnv, timeout: 30_000, maxBuffer: 30 * 1024 * 1024 });
          const { session, transcript } = JSON.parse(text);
          const bytes = await readFile(sourcePath);
          if (sourcePath.endsWith('.zst') && typeof zlib.zstdDecompressSync !== 'function') throw new Error('zstd unavailable');
          const raw = sourcePath.endsWith('.zst') ? zlib.zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8');
          const source = sourceMessages(agent, raw);
          sources[session.id] = { agent, path: sourcePath };
          const times = uniqueTimes(source);
          for (const message of source) {
            if (message.event || times.get(message.time) === 1) anchors.push({ session: hashText(session.id), text: hashText(message.text.trim()), time: message.time, id: eventKey(session.id, message) });
          }
          const found = matchMessages(session, transcript, source);
          const expected = (transcript.parts || []).filter(p => p.role === 'user' && p.kind === 'text' && p.text?.trim() && !/^Generate a title that will help the user recognize this T3 Code thread/.test(p.text)).length;
          unmatched += Math.max(0, expected - found.length);
          records.push(...found);
          read++;
          if (transcript.cut) truncated++;
        } catch { failed++; }
      }
    }
    await Promise.all([worker(), worker()]);
    records.sort((a, b) => a.time.localeCompare(b.time));
    // Keep earlier data for sessions that temporarily fail to read.
    const previous = await readHistory(directory);
    const ids = new Set(records.map(r => r.id));
    if (failed || unsupported) {
      for (const record of previous?.records || []) if (!ids.has(record.id)) records.push(record);
      const anchorIds = new Set(anchors.map(anchor => anchor.id));
      for (const anchor of previous?.anchors || []) if (!anchorIds.has(anchor.id)) anchors.push(anchor);
      for (const [id, source] of Object.entries(previous?.sources || {})) sources[id] ||= source;
    }
    records.sort((a, b) => a.time.localeCompare(b.time));
    const snapshot = { version: 1, updated: new Date().toISOString(), sessions: refs.length, read, failed, truncated, unsupported, unmatched, records, anchors, sources };
    const tmp = join(directory, `.history-${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(tmp, join(directory, fileName));
    await rm(join(directory, '.history-error'), { force: true });
    return { version: snapshot.version, updated: snapshot.updated, sessions: refs.length, read, failed, truncated, unsupported, unmatched, records: records.length };
  } catch (error) {
    await writeFile(join(directory, '.history-error'), '历史同步失败：请确认 Magpie 已允许读取会话，并且 sqlite3 可用。', { mode: 0o600 }).catch(() => {});
    throw error;
  } finally { await rm(lock, { force: true }); }
}

export async function readHistory(directory) {
  try { const data = JSON.parse(await readFile(join(directory, fileName), 'utf8')); return data.version === 1 ? data : null; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
