import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

export function isAutomaticPrompt(agent, text) {
  return agent === 't3code' && /^Generate a title that will help the user recognize this T3 Code thread/.test(text);
}

export function parseEntries(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    const marker = /^<!-- magpie-prompt:([a-f0-9]{64}) -->$/.exec(lines[i]);
    if (!marker) { i++; continue; }
    const header = /^## (\d{2}:\d{2}:\d{2}) · (.*?) · (.*)$/.exec(lines[++i] || '');
    if (!header) continue;
    while (i + 1 < lines.length && !lines[i + 1].trim()) i++;
    const fence = /^(`{3,})text$/.exec(lines[++i] || '');
    if (!fence) continue;
    const text = [];
    while (++i < lines.length && lines[i] !== fence[1]) text.push(lines[i]);
    if (i === lines.length) break;
    const images = [];
    let sessionHash = '', nativeEvent = '';
    while (++i < lines.length && !/^<!-- magpie-prompt:[a-f0-9]{64} -->$/.test(lines[i])) {
      const match = /^!\[附件\]\((attachments\/[a-f0-9]{64}\.(?:png|jpg|gif|webp))\)$/.exec(lines[i]);
      if (match) images.push(match[1]);
      const session = /^<!-- magpie-session:([a-f0-9]{64}) -->$/.exec(lines[i]);
      if (session) sessionHash = session[1];
      const event = /^<!-- magpie-event:([a-f0-9]{64}) -->$/.exec(lines[i]);
      if (event) nativeEvent = event[1];
    }
    entries.push({ id: marker[1], time: header[1], agent: header[2], cwd: header[3], text: text.join('\n'), images, sessionHash, nativeEvent });
  }
  return entries;
}

// Support the attachment notation T3 Code records in existing prompts.
export function splitAttachments(text, removePaths = null) {
  const paths = [];
  const display = text.replace(/^\[Attached image "[^"\n]*" is saved at: ([^\]\n]+)\]\s*$/gm, (line, path) => {
    paths.push(path);
    return removePaths === null || removePaths.has(path) ? '' : line;
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { display, paths };
}

export function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png', 'png'];
  if (bytes.subarray(0, 3).equals(Buffer.from([255,216,255]))) return ['image/jpeg', 'jpg'];
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return ['image/gif', 'gif'];
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return ['image/webp', 'webp'];
  return null;
}

export async function imageData(path, root) {
  try {
    const base = await realpath(root);
    const full = await realpath(path);
    const rel = relative(base, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const info = await stat(full);
    if (!info.isFile() || info.size > 5 * 1024 * 1024) return null;
    const bytes = await readFile(full);
    const type = imageType(bytes);
    return type ? `data:${type[0]};base64,${bytes.toString('base64')}` : null;
  } catch { return null; }
}

export async function entryImages(entry, directory) {
  const { paths } = splitAttachments(entry.text);
  const attachments = join(directory, 'attachments');
  const t3 = join(homedir(), '.t3', 'userdata', 'attachments');
  const savedImages = await Promise.all(entry.images.map((path) => imageData(join(directory, path), attachments)));
  const localImages = await Promise.all(paths.map((path) => imageData(path, t3)));
  return {
    images: [...new Set([...savedImages, ...localImages].filter(Boolean))],
    displayedPaths: new Set(paths.filter((_, index) => localImages[index])),
  };
}
