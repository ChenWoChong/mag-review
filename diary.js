import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

const imageExtensions = new Map([
  ['image/png', ['png']],
  ['image/jpeg', ['jpg', 'jpeg']],
  ['image/gif', ['gif']],
  ['image/webp', ['webp']],
]);

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

async function preview(attachment, root) {
  if (!/^[\w-]+$/.test(attachment.id)) return null;
  for (const ext of imageExtensions.get(attachment.mimeType) || []) {
    try {
      const path = await realpath(join(root, `${attachment.id}.${ext}`));
      if (!path.startsWith(`${root}${sep}`)) continue;
      const info = await stat(path);
      if (!info.isFile() || info.size > 5 * 1024 * 1024) continue;
      const bytes = await readFile(path);
      if (imageMime(bytes) === attachment.mimeType) return `data:${attachment.mimeType};base64,${bytes.toString('base64')}`;
    } catch { /* Missing or unreadable attachments still have a name. */ }
  }
  return null;
}

export async function entryImages(entry, t3DataDirectory) {
  if (entry.source !== 't3code' || !t3DataDirectory || !entry.hasImage) return [];
  let root;
  try { root = await realpath(join(t3DataDirectory, 'userdata', 'attachments')); } catch { return []; }
  const images = await Promise.all(entry.attachments.map(attachment => preview(attachment, root)));
  return images.filter(Boolean);
}
