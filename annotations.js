import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const empty = () => ({ version: 1, entries: {}, pinned: [], templates: {}, feedback: {} });
let pending = Promise.resolve();

export async function readAnnotations(directory) {
  try {
    const data = JSON.parse(await readFile(join(directory, '.annotations.json'), 'utf8'));
    if (data.version !== 1 || !data.entries || !Array.isArray(data.pinned)) throw new Error('Invalid annotations');
    data.templates ||= {};
    data.feedback ||= {};
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return empty();
    throw error;
  }
}

export function updateAnnotations(directory, action) {
  const work = pending.then(async () => {
    const data = await readAnnotations(directory);
    const tag = typeof action.tag === 'string' ? action.tag.trim() : '';
    if (action.type === 'feedback') {
      if (!/^[a-f0-9]{64}$/.test(action.id || '') || !['saved', 'dismissed'].includes(action.value)) throw new Error('Invalid feedback');
      data.feedback[action.id] = action.value;
    } else if (action.type === 'template-save' || action.type === 'template-delete') {
      if (!/^[a-f0-9]{64}$/.test(action.id || '')) throw new Error('Invalid template');
      if (action.type === 'template-delete') delete data.templates[action.id];
      else {
        const title = typeof action.title === 'string' ? action.title.trim() : '';
        if (!title || title.length > 80 || typeof action.text !== 'string' || !action.text.trim() || action.text.length > 200000) throw new Error('Invalid template');
        data.templates[action.id] = { title, text: action.text };
      }
    } else if (action.type === 'pin') {
      if (!tag || tag.length > 32) throw new Error('Invalid tag');
      data.pinned = action.value ? [...new Set([...data.pinned, tag])] : data.pinned.filter(item => item !== tag);
    } else {
      const ids = Array.isArray(action.ids) ? action.ids : [action.id];
      if (!ids.length || ids.length > 100 || ids.some(id => !/^[a-f0-9]{64}$/.test(id || ''))) throw new Error('Invalid record');
      for (const id of ids) {
        const current = data.entries[id] || { favorite: false, hidden: false, tags: [] };
        if (action.type === 'favorite' || action.type === 'hidden') current[action.type] = action.value === true;
        else if (action.type === 'tag') {
          if (!tag || tag.length > 32) throw new Error('Invalid tag');
          current.tags = action.value ? [...new Set([...current.tags, tag])].slice(0, 20) : current.tags.filter(item => item !== tag);
        } else throw new Error('Invalid action');
        data.entries[id] = current;
      }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, `.annotations-${process.pid}.tmp`);
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, join(directory, '.annotations.json'));
  });
  pending = work.catch(() => {});
  return work;
}
