import { lstat, readlink, stat } from 'node:fs/promises';
import { join, basename, dirname, isAbsolute, normalize, parse, resolve, sep } from 'node:path';
import { readSubmissions } from './submissions.js';
import { readNativeHistory } from './native-history.js';

const pad = n => String(n).padStart(2, '0');
export function localDate(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
export function localTime(value) {
  const d = new Date(value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Bun's realpath can hang on some macOS folders (for example ~/Downloads),
// which would leave every page request waiting forever. Resolve symlinks by
// hand instead; lstat and readlink are reliable in the Magpie plugin host.
async function canonicalPath(input) {
  const absolute = resolve(input);
  const root = parse(absolute).root;
  let current = root;
  let queue = absolute.slice(root.length).split(sep).filter(Boolean);
  let links = 0;
  while (queue.length) {
    const part = queue.shift();
    if (part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const next = join(current, part);
    if (!(await lstat(next)).isSymbolicLink()) { current = next; continue; }
    if (++links > 40) throw Object.assign(new Error('Too many symbolic links'), { code: 'ELOOP' });
    const target = await readlink(next);
    const resolved = isAbsolute(target) ? target : resolve(dirname(next), target);
    const targetRoot = parse(resolved).root;
    current = targetRoot;
    queue = [...resolved.slice(targetRoot.length).split(sep).filter(Boolean), ...queue];
  }
  return current;
}

// Resolve only directories that still exist. Historical paths remain distinct and
// are never discarded merely because the original checkout has disappeared.
async function projectFor(cwd) {
  if (!cwd || cwd === '未知') return { project: '未知项目', projectId: 'unknown:', projectKind: 'unknown', projectPath: '' };
  const original = normalize(cwd);
  let path;
  try {
    path = await canonicalPath(original);
    if (!(await stat(path)).isDirectory()) throw new Error('not a directory');
  } catch {
    return { project: basename(original), projectId: `path:${original}`, projectKind: 'unconfirmed', projectPath: original };
  }
  if (isAbsolute(path)) {
    for (let dir = path; ; dir = dirname(dir)) {
      try {
        await stat(join(dir, '.git'));
        return { project: basename(dir), projectId: `path:${dir}`, projectKind: 'git', projectPath: dir };
      } catch {}
      if (dirname(dir) === dir) break;
    }
  }
  return { project: basename(path), projectId: `path:${path}`, projectKind: 'directory', projectPath: path };
}

export async function loadRecords(directory) {
  const submissions = await readSubmissions(directory);
  let history = [];
  // A missing or unreadable history database must not interrupt live records.
  try { history = readNativeHistory(directory); } catch {}
  const records = submissions.concat(history);
  records.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id));
  const projects = new Map();
  return Promise.all(records.map(async record => {
    const root = record.projectRoot || record.cwd || '';
    if (!projects.has(root)) projects.set(root, projectFor(root));
    const project = record.source === 'native_history' && record.projectName
      ? { project: record.projectName, projectId: `history:${record.projectName}`, projectKind: 'history', projectPath: '' }
      : await projects.get(root);
    return {
      ...record,
      ...project,
      day: localDate(record.submittedAt),
      time: localTime(record.submittedAt),
      hasImage: record.attachments.some(attachment => attachment.mimeType.startsWith('image/')),
    };
  }));
}

export function annotate(entry, data) {
  return data.entries[entry.id] || { favorite: false, hidden: false, tags: [] };
}
