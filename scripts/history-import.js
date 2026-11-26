import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { hashText } from '../identity.js';
import { hasNativeHistory, publishNativeHistory, readNativeHistory } from '../native-history.js';
import { isPiCompactionSummary } from '../pi-context.js';
import { isContextText, withoutDejaRecall } from '../prompt-context.js';
import { normalizeGatewayAttachments } from '../t3-image-markup.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const standaloneContext = /^\s*(?:# AGENTS\.md instructions\s+<INSTRUCTIONS>|Generate a title that will help the user recognize this T3 Code thread\b|You generate concise git branch names\.\s*\n|Context handoff \(full_thread_summary\):\s*Provider context handoff\.)/;

function bundledDeja() {
  const fromDeja = createRequire(require.resolve('@vshulcz/deja-vu/bin/deja'));
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const exe = platform === 'windows' ? 'deja.exe' : 'deja';
  return fromDeja.resolve(`@vshulcz/deja-vu-${platform}-${arch}/bin/${exe}`);
}

function historyRecord(row) {
  if (row?.role !== 'user' || row.kind === 'subagent' || row.parent || row.lifecycle || row.harness === 'deja') return null;
  const { harness: agent, session_id: session, project, time } = row;
  if (typeof agent !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(agent)
    || typeof session !== 'string' || !session.trim() || session.length > 1024
    || typeof time !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(time) || time.startsWith('0001-')
    || !Number.isFinite(Date.parse(time)) || typeof row.text !== 'string' || row.text.length > 200000 || !row.text.trim()) return null;
  const text = withoutDejaRecall(row.text);
  if (!text.trim() || isContextText(text, agent) || standaloneContext.test(text) || (agent === 'pi' && isPiCompactionSummary(text))) return null;
  return {
    id: hashText(JSON.stringify(['native_history', agent, session, time, row.text])),
    source: 'native_history', evidence: 'deja_export', agent, session, submittedAt: new Date(time).toISOString(),
    projectName: typeof project === 'string' ? project.trim().slice(0, 512) : '',
    ...normalizeGatewayAttachments(text, []),
  };
}

async function readExport(directory) {
  const records = new Map();
  const agents = Object.create(null);
  let skipped = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const file of entries) {
    if (!file.isFile() || !/^deja-sync-.*\.jsonl$/.test(file.name)) continue;
    const stream = createReadStream(join(directory, file.name), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); }
        catch { throw new Error('Invalid JSON in deja-vu export'); }
        if (row?.role !== 'user') continue;
        const record = historyRecord(row);
        if (!record || records.has(record.id)) { skipped++; continue; }
        records.set(record.id, record);
        agents[record.agent] = (agents[record.agent] || 0) + 1;
      }
    } finally { lines.close(); stream.destroy(); }
  }
  return { records, agents, skipped };
}

async function exportDejaHistory(work, output) {
  const env = { ...process.env, DEJA_INDEX_DIR: join(work, 'index'), DEJA_OFFLINE: '1', DEJA_NO_UPDATE_NOTICE: '1',
    DEJA_EMBED_OFF: '1', DEJA_INCLUDE_SUBAGENTS: '0', DEJA_INDEX_TOOL_OUTPUT: '0', DEJA_INDEX_COMMANDS: '0', DEJA_INDEX_EDITS: '0' };
  try {
    await run(bundledDeja(), ['sync', 'export', output, '--full'], { cwd: work, env, timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch (error) {
    throw new Error(`deja-vu export failed (${error.killed ? 'timeout' : error.code ?? 'unknown error'})`);
  }
}

export async function importHistory(directory, { apply = false, ifMissing = false, exportHistory = exportDejaHistory } = {}) {
  if (ifMissing && hasNativeHistory(directory)) return { alreadyImported: true };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(directory, '.history-import-'));
  try {
    const output = join(work, 'export');
    await mkdir(output, { mode: 0o700 });
    await exportHistory(work, output);
    const { records, agents, skipped } = await readExport(output);
    let added;
    if (apply) added = publishNativeHistory(directory, records.values());
    else {
      for (const record of readNativeHistory(directory)) records.delete(record.id);
      added = records.size;
    }
    return { applied: apply, added, skipped, agents };
  } finally { await rm(work, { recursive: true, force: true }); }
}
