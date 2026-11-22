// Read Magpie's own session index and transcript API. Print counts only.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { parseEntries } from '../diary.js';
import { directoryFor } from '../storage.js';

const exec = promisify(execFile);
const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'magpie', 'said-v1.db');
const { stdout } = await exec('sqlite3', ['-readonly', cache, 'select key from files order by key'], { maxBuffer: 20 * 1024 * 1024 });
const refs = stdout.trim().split('\n').filter(Boolean);
let next = 0;
const results = { indexedSessions: refs.length, readSessions: 0, unreadableSessions: 0, truncatedSessions: 0, userMessages: 0, byAgent: {} };
const nativePrompts = new Map();
async function worker() {
  while (next < refs.length) {
    const ref = refs[next++];
    try {
      const { stdout: json } = await exec('magpie', ['sessions', 'show', ref, '--json'], { maxBuffer: 30 * 1024 * 1024, timeout: 30_000 });
      const { session, transcript } = JSON.parse(json);
      results.readSessions++;
      results.byAgent[session.agent] = (results.byAgent[session.agent] || 0) + 1;
      if (transcript.cut) results.truncatedSessions++;
      for (const part of transcript.parts || []) {
        if (part.role !== 'user' || part.kind !== 'text' || !part.text?.trim()) continue;
        const text = part.text.trim();
        nativePrompts.set(text, (nativePrompts.get(text) || 0) + 1);
        results.userMessages++;
      }
    } catch { results.unreadableSessions++; }
  }
}
await Promise.all(Array.from({ length: 2 }, worker));
const directory = directoryFor({});
let current = [];
try {
  for (const f of await readdir(directory)) {
    if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) current.push(...parseEntries(await readFile(join(directory, f), 'utf8')));
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const counts = new Map();
for (const entry of current) counts.set(entry.text.trim(), (counts.get(entry.text.trim()) || 0) + 1);
const repeated = [...counts].filter(([, count]) => count > 1);
results.existingRecords = current.length;
results.duplicatedTextGroups = repeated.length;
results.extraRecordsWithIdenticalText = repeated.reduce((n, [, count]) => n + count - 1, 0);
results.duplicateGroupsFoundInNativeHistory = repeated.filter(([text]) => nativePrompts.has(text)).length;
results.nativeOccurrencesForDuplicateGroups = repeated.reduce((n, [text]) => n + (nativePrompts.get(text) || 0), 0);
results.note = '仅输出统计，不导出或修改历史会话；相同文本可能是用户有意重复发送。';
console.log(JSON.stringify(results, null, 2));
