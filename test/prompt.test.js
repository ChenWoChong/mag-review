import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onRequest } from '../prompt.hooks.js';

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-prompt-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function log(directory) {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.md'));
  return files.length ? readFile(join(directory, files[0]), 'utf8') : '';
}

function context(directory, agent, query, session = 'session-1') {
  return { origin: 'local', agent, query, session, cwd: '/work/project', options: { directory } };
}

test('Codex Responses requests record each user turn once, even across tool calls', async () => withDirectory(async (directory) => {
  const ctx = context(directory, 'codex', '修复问题\n保留原文');
  const first = { input: [{ role: 'user', content: [{ type: 'input_text', text: ctx.query }] }] };
  await Promise.all([onRequest(first, ctx), onRequest(first, ctx)]);
  await onRequest({ input: [...first.input, { type: 'function_call_output', output: 'done' }] }, ctx);
  await onRequest({ input: [...first.input, { role: 'user', content: '<task-notification>finished</task-notification>' }] }, ctx);
  const second = '继续';
  await onRequest({ input: [...first.input, { role: 'assistant', content: '完成' }, { role: 'user', content: second }] }, { ...ctx, query: second });
  const output = await log(directory);
  assert.equal((output.match(/<!-- magpie-prompt:/g) || []).length, 2);
  assert.match(output, /修复问题\n保留原文/);
  assert.match(output, /继续/);
  const file = (await readdir(directory)).find((name) => name.endsWith('.md'));
  assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
}));

test('Claude and Pi tool results are ignored for deduplication', async () => withDirectory(async (directory) => {
  for (const agent of ['claude', 'pi']) {
    const ctx = context(directory, agent, '检查这个项目');
    const initial = { messages: [{ role: 'user', content: [{ type: 'text', text: ctx.query }] }] };
    const afterTool = { messages: [...initial.messages, { role: 'assistant', content: [{ type: 'tool_use', id: '1' }] }, { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] }] };
    await onRequest(initial, ctx);
    await onRequest(afterTool, ctx);
  }
  assert.equal(((await log(directory)).match(/<!-- magpie-prompt:/g) || []).length, 2);
}));

test('the same prompt in a new session or a later turn is preserved', async () => withDirectory(async (directory) => {
  const ctx = context(directory, 'pi', '再试一次');
  const user = { role: 'user', content: ctx.query };
  await onRequest({ messages: [user] }, ctx);
  await onRequest({ messages: [user] }, { ...ctx, session: 'session-2' });
  await onRequest({ messages: [user, { role: 'assistant', content: '好的' }, user] }, ctx);
  assert.equal(((await log(directory)).match(/<!-- magpie-prompt:/g) || []).length, 3);
}));

test('skips remote, unknown-origin, subagent and empty requests', async () => withDirectory(async (directory) => {
  const ctx = context(directory, 'codex', 'private');
  for (const changes of [{ origin: 'remote' }, { origin: 'gateway-key' }, { origin: '' }, { kind: 'subagent' }, { query: '' }]) {
    await onRequest({}, { ...ctx, ...changes });
  }
  assert.equal(await log(directory), '');
}));

test('uses a longer Markdown fence when prompt contains code fences', async () => withDirectory(async (directory) => {
  const prompt = '```js\nhello()\n```';
  await onRequest({ messages: [{ role: 'user', content: prompt }] }, context(directory, 'pi', prompt));
  assert.match(await log(directory), /````text\n```js\nhello\(\)\n```\n````/);
}));
