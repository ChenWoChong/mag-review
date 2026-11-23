import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onRequest } from '../prompt.hooks.js';
import { readSubmissions, verifyStore, withStore } from '../submissions.js';

async function withDiary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-input-'));
  const ctx = { protocol: 'responses', agent: 'codex', origin: 'local', session: 'session', options: { directory } };
  try { await run(directory, (body, options) => onRequest(body, { ...ctx, ...options })); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const user = (content, id) => ({ role: 'user', content, id });
const answer = { role: 'assistant', content: 'reply' };

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aS8AAAAASUVORK5CYII=';

test('captures new inputs across all four protocols and associates only gateway observations', async () => withDiary(async (directory, send) => {
  send({ input: 'responses' });
  send({ messages: [user('chat')] }, { protocol: 'chat' });
  send({ messages: [user([{ type: 'text', text: 'messages' }])] }, { protocol: 'anthropic' });
  send({ contents: [{ role: 'user', parts: [{ text: 'gemini' }] }] }, { protocol: 'gemini' });
  send({ input: 'outside' }, { origin: 'remote' });
  send({ input: 'unapproved key' }, { origin: 'magpie-key' });
  assert.deepEqual((await readSubmissions(directory)).map(r => r.text), ['responses', 'chat', 'messages', 'gemini']);
  assert.equal(verifyStore(directory).missingCapture, 0);
  assert.equal((await stat(join(directory, 'gateway-diary.sqlite'))).mode & 0o777, 0o600);
}));

test('deduplicates exact replays and tool rounds, while preserving two identifiable same-text inputs', async () => withDiary(async (directory, send) => {
  const first = user('继续', 'one');
  const tool = { type: 'function_call_output', call_id: 'call', output: 'result' };
  assert.equal(send({ input: [first] }), undefined);
  send({ input: [first] });
  send({ input: [first, answer, tool] });
  send({ input: [first, answer, user('继续', 'two')] });
  send({ input: [user('继续', 'two')] });
  assert.deepEqual((await readSubmissions(directory)).map(r => r.text), ['继续', '继续']);
  assert.equal(withStore(directory, db => db.prepare('SELECT count(*) AS n FROM capture_prompts').get().n), 6);
}));

test('uses full history boundaries without importing older messages or merging a changed history', async () => withDiary(async (directory, send) => {
  const history = [user('old', 'old-id'), answer, user('unresolved', 'old-id-2')];
  send({ input: history });
  assert.deepEqual(await readSubmissions(directory), []);
  send({ input: [...history, answer, user('继续')] });
  send({ input: [...history, answer, user('继续')] });
  send({ input: [user('继续')] });
  send({ input: [...history, answer, user('继续'), answer, user('继续')] });
  assert.deepEqual((await readSubmissions(directory)).map(r => r.text), ['继续', '继续']);
}));

test('records a new input after a long client history without importing the baseline', async () => withDiary(async (directory, send) => {
  const history = [user('old'), ...Array.from({ length: 700 }, (_, i) => ({ ...answer, content: `previous item ${i}` }))];
  send({ input: history });
  send({ input: [...history, user('new after long history')] });
  assert.deepEqual((await readSubmissions(directory)).map(row => row.text), ['new after long history']);
}));

test('identical deltas with different previous response IDs are distinct', async () => withDiary(async (directory, send) => {
  for (const previous_response_id of ['resp_1', 'resp_1', 'resp_2']) send({ input: [user('继续')], previous_response_id });
  assert.equal((await readSubmissions(directory)).length, 2);
}));

test('handles mixed Codex context, skips auxiliary requests and keeps arrival independent of model success', async () => withDiary(async (directory, send) => {
  send({ input: [user('<environment_context>only context</environment_context>'), user('visible prompt')] });
  send({ input: [user('title body')] }, { kind: 'thread_title', session: 'title' });
  send({ input: [user('review payload')], user: 'magpie-prompt-diary-review' }, { session: 'review' });
  send({ input: [user('[pi-lens automated check — not a user request] Address 🔴 blockers before continuing')] }, { agent: 'pi', session: 'pi' });
  send({ input: [user('Context handoff (full_thread_summary):\nProvider context handoff.\ncombined')] }, { agent: 'pi', session: 'pi' });
  const quoted = '[pi-lens automated check — not a user request] 是什么意思？';
  send({ input: quoted }, { agent: 'pi', session: 'pi-quoted' });
  assert.deepEqual((await readSubmissions(directory)).map(r => r.text), ['visible prompt', quoted]);
  assert.equal(verifyStore(directory).observations.find(r => r.result === 'automatic').count, 2);
}));

test('rolls back a failed write and can record the same request after recovery', async () => withDiary(async (directory, send) => {
  withStore(directory, db => db.exec("CREATE TRIGGER deny_prompt BEFORE INSERT ON prompts BEGIN SELECT RAISE(ABORT, 'test write failure'); END"));
  assert.throws(() => send({ input: 'retry me' }), /test write failure/);
  assert.deepEqual(verifyStore(directory).observations, []);
  withStore(directory, db => db.exec('DROP TRIGGER deny_prompt'));
  send({ input: 'retry me' });
  assert.equal(verifyStore(directory).prompts, 1);
}));

test('stores actual image bytes and ignores text pointers and remote URLs', async () => withDiary(async (directory, send) => {
  send({ input: [user([{ type: 'input_image', image_url: `data:image/png;base64,${image}` }])] });
  send({ input: [user([{ type: 'input_image', image_url: 'https://example.com/image.png' }])] }, { session: 'remote-image' });
  const [record] = await readSubmissions(directory);
  assert.equal(record.text, '');
  assert.equal(record.attachments.length, 1);
  assert.equal(withStore(directory, db => db.prepare('SELECT count(*) AS n FROM images').get().n), 1);
  assert.equal(verifyStore(directory).prompts, 1);
}));
