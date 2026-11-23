import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { isAutomaticPrompt, parseEntries, splitAttachments } from './diary.js';
import { readHistory } from './history-import.js';
import { hashText } from './identity.js';

const pad = n => String(n).padStart(2, '0');
export function localDate(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
export function localTime(value) {
  const d = new Date(value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Older diary entries did not save their session. Magpie's local usage ledger
// can identify it when exactly one session made a request in that second.
async function sessionsFromUsage(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return new Map(); }
  const sessions = new Map();
  for (const line of text.split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!row.agent || !row.session || !row.t || Number.isNaN(Date.parse(row.t))) continue;
    const key = JSON.stringify([row.agent, localDate(row.t), localTime(row.t)]);
    if (!sessions.has(key)) sessions.set(key, new Set());
    sessions.get(key).add(hashText(row.session));
  }
  return sessions;
}

export async function loadRecords(directory, options = {}) {
  let files;
  try { files = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
  const history = await readHistory(directory);
  const imported = (history?.records || []).map(record => ({ ...record, day: localDate(record.time), time: localTime(record.time), images: [], source: '原生会话', aliases: [] }));
  const importedEvents = new Map(imported.filter(r => r.nativeEvent).map(r => [r.nativeEvent, r]));
  const anchors = new Map();
  for (const anchor of history?.anchors || []) {
    const key = JSON.stringify([anchor.session, anchor.text]);
    if (!anchors.has(key)) anchors.set(key, []);
    anchors.get(key).push(anchor);
  }
  for (const events of anchors.values()) events.sort((a, b) => a.time.localeCompare(b.time));
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const usage = await sessionsFromUsage(options.usagePath || join(config, 'magpie', 'usage.jsonl'));
  const local = [], localEvents = new Map();
  for (const name of files.filter(file => /^\d{4}-\d{2}-\d{2}\.md$/.test(file)).sort()) {
    const content = await readFile(join(directory, name), 'utf8');
    for (const entry of parseEntries(content)) {
      if (isAutomaticPrompt(entry.agent, entry.text)) continue;
      const day = name.slice(0, -3);
      const candidates = usage.get(JSON.stringify([entry.agent, day, entry.time]));
      const session = entry.sessionHash || (candidates?.size === 1 ? [...candidates][0] : '');
      const at = new Date(`${day}T${entry.time}`).getTime();
      const native = entry.nativeEvent || (anchors.get(JSON.stringify([session, hashText(entry.text.trim())])) || [])
        .findLast(anchor => Date.parse(anchor.time) <= at + 1000)?.id || '';
      const candidate = native && (importedEvents.get(native) || localEvents.get(native));
      const match = candidate && candidate.text.trim() === entry.text.trim() ? candidate : null;
      if (match) {
        match.aliases.push(entry.id);
        match.images = [...new Set([...match.images, ...entry.images])];
      } else {
        const record = { ...entry, sessionHash: session, day, source: '网关实时记录', aliases: [] };
        local.push(record);
        if (native) localEvents.set(native, record);
      }
    }
  }
  const records = [...local, ...imported];
  for (const entry of records) {
    entry.project = entry.cwd && entry.cwd !== '未知' ? basename(entry.cwd.replace(/\/$/, '')) : '未知项目';
    entry.hasImage = entry.images.length > 0 || splitAttachments(entry.text).paths.length > 0;
  }
  records.sort((a, b) => `${b.day} ${b.time}`.localeCompare(`${a.day} ${a.time}`));
  return { records, history, files };
}

export function annotate(entry, data) {
  const marks = [entry.id, ...entry.aliases].map(id => data.entries[id]).filter(Boolean);
  return { favorite: marks.some(x => x.favorite), hidden: marks.some(x => x.hidden), tags: [...new Set(marks.flatMap(x => x.tags || []))] };
}
