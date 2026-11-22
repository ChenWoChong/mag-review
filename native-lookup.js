import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readHistory, sourceMessages } from './history-import.js';
import { eventKey } from './identity.js';

let cachedHistory = null;
const sources = new Map();

// Codex writes a stable user-message ID before its model request. Prefer it
// to a hash of a request history that can change during a tool loop.
export async function nativeEvent(directory, session, prompt) {
  if (!session) return null;
  try {
    const index = await stat(join(directory, '.history.json'));
    if (!cachedHistory || cachedHistory.directory !== directory || cachedHistory.mtime !== index.mtimeMs || cachedHistory.size !== index.size) {
      cachedHistory = { directory, mtime: index.mtimeMs, size: index.size, data: await readHistory(directory) };
      sources.clear();
    }
    const source = cachedHistory.data?.sources?.[session];
    if (!source || source.agent !== 'codex' || source.path.endsWith('.zst')) return null;
    const info = await stat(source.path);
    let cached = sources.get(session);
    if (!cached || cached.path !== source.path || cached.size !== info.size || cached.mtime !== info.mtimeMs) {
      const length = Math.min(info.size, 2 * 1024 * 1024);
      const file = await open(source.path, 'r');
      try {
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await file.read(bytes, 0, length, info.size - length);
        let text = bytes.subarray(0, bytesRead).toString('utf8');
        if (info.size > length) text = text.slice(text.indexOf('\n') + 1);
        cached = { path: source.path, size: info.size, mtime: info.mtimeMs, events: sourceMessages('codex', text) };
      } finally { await file.close(); }
      if (sources.size >= 64) sources.delete(sources.keys().next().value);
      sources.set(session, cached);
    }
    const match = cached.events.findLast(event => event.text.trim() === prompt.trim() && event.event);
    return match ? eventKey(session, match) : null;
  } catch { return null; }
}
