import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { directoryFor } from './storage.js';
import { imageType, isAutomaticPrompt } from './diary.js';
import { hashText } from './identity.js';
import { nativeEvent } from './native-lookup.js';

const indexes = new Map();
let pending = Promise.resolve();

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && (part.type === undefined || ['text', 'input_text'].includes(part.type)) && typeof part.text === 'string')
    .map((part) => part.text).join('\n');
}

// Tool results are often represented as user messages. Only retain textual parts.
function userHistory(body) {
  const items = Array.isArray(body?.messages) ? body.messages
    : Array.isArray(body?.input) ? body.input
      : Array.isArray(body?.contents) ? body.contents : [];
  return items.filter((item) => item?.role === 'user')
    .map((item) => textContent(item.content ?? item.parts))
    .filter((text) => text.trim());
}

function fingerprint(body, ctx, prompt) {
  let history = userHistory(body);
  // Magpie may skip agent notices after the last real user message when
  // extracting query. Do not let those notices create another record.
  const lastPrompt = history.findLastIndex((text) => text.includes(prompt));
  if (lastPrompt >= 0) history = history.slice(0, lastPrompt + 1);
  else history.push(prompt);
  // A named session and the occurrence number of the same user text remain
  // stable when a tool round changes unrelated messages in the history.
  // Without a session, retain the full history rather than merging all users.
  const occurrence = history.filter(text => text.includes(prompt)).length;
  return createHash('sha256').update(JSON.stringify([
    ctx.caller?.agent || ctx.agent || '', ctx.session || '', ctx.cwd || '',
    ctx.session ? [prompt, occurrence] : history,
  ])).digest('hex');
}

function dayAndTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

function label(value) {
  return typeof value === 'string' && value.trim() ? value.replace(/[\r\n]+/g, ' ').trim() : '未知';
}

async function saveImages(body, prompt, directory) {
  const messages = Array.isArray(body?.messages) ? body.messages
    : Array.isArray(body?.input) ? body.input
      : Array.isArray(body?.contents) ? body.contents : [];
  const message = messages.findLast((item) => item?.role === 'user' && textContent(item.content ?? item.parts).includes(prompt));
  const parts = Array.isArray(message?.content) ? message.content : Array.isArray(message?.parts) ? message.parts : [];
  const saved = [];
  for (const part of parts) {
    const url = typeof part?.image_url === 'string' ? part.image_url : part?.image_url?.url;
    const data = typeof url === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(url)
      ? url.slice(url.indexOf(',') + 1)
      : part?.source?.type === 'base64' ? part.source.data
        : part?.inline_data?.data ?? part?.inlineData?.data;
    if (typeof data !== 'string' || data.length > 7_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    const bytes = Buffer.from(data, 'base64');
    const type = imageType(bytes);
    if (!type || bytes.length > 5 * 1024 * 1024) continue;
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${type[1]}`;
    const folder = join(directory, 'attachments');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, name), bytes, { mode: 0o600 });
    saved.push(`![附件](attachments/${name})`);
  }
  return saved;
}

async function loadIndex(directory) {
  if (indexes.has(directory)) return indexes.get(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await readdir(directory);
  const seen = new Set();
  for (const name of entries.filter((entry) => /^\d{4}-\d{2}-\d{2}\.md$/.test(entry))) {
    const content = await readFile(join(directory, name), 'utf8');
    for (const match of content.matchAll(/^<!-- magpie-prompt:([a-f0-9]{64}) -->$/gm)) seen.add(match[1]);
  }
  indexes.set(directory, seen);
  return seen;
}

async function record(body, ctx) {
  // Gateway sharing keys can be used by other people. Record only requests
  // Magpie identifies as coming from this computer, and skip subagents.
  if (!['local', 'magpie-key'].includes(ctx.origin) || ctx.kind === 'subagent') return;
  const prompt = ctx.query;
  if (typeof prompt !== 'string' || !prompt.trim()) return;
  if (isAutomaticPrompt(ctx.caller?.agent || ctx.agent, prompt)) return;
  const directory = directoryFor(ctx.options);
  const seen = await loadIndex(directory);
  const native = await nativeEvent(directory, ctx.session, prompt);
  const id = native || fingerprint(body, ctx, prompt);
  if (seen.has(id)) return;
  const { day, time } = dayAndTime(new Date());
  const path = join(directory, `${day}.md`);
  const longest = Math.max(2, ...Array.from(prompt.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const agent = label(ctx.caller?.agent || ctx.agent);
  const images = await saveImages(body, prompt, directory);
  const metadata = `${ctx.session ? `<!-- magpie-session:${hashText(ctx.session)} -->\n` : ''}${native ? `<!-- magpie-event:${native} -->\n` : ''}`;
  const entry = `\n<!-- magpie-prompt:${id} -->\n## ${time} · ${agent} · ${label(ctx.cwd)}\n\n${fence}text\n${prompt}\n${fence}\n${metadata}${images.join('\n')}${images.length ? '\n' : ''}`;
  await appendFile(path, entry, { encoding: 'utf8', mode: 0o600 });
  // Existing files could have been created with wider permissions.
  await chmod(path, 0o600);
  seen.add(id);
}

export async function onRequest(body, ctx) {
  // Serialize writes within the plugin host so simultaneous retries cannot race.
  const write = pending.then(() => record(body, ctx));
  pending = write.catch(() => {});
  await write;
}
