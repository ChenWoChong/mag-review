import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecords } from '../records.js';
import { readSubmissions, writeSubmissions } from '../submissions.js';
import { readT3Submissions } from '../t3-submissions.js';

const schema = `
CREATE TABLE orchestration_v2_projection_messages(message_id PRIMARY KEY, thread_id, run_id, role, created_at, payload_json);
CREATE TABLE orchestration_v2_projection_threads(thread_id PRIMARY KEY, project_id, default_provider, deleted_at, payload_json);
CREATE TABLE projection_projects(project_id PRIMARY KEY, workspace_root);
CREATE TABLE orchestration_v2_projection_runs(run_id PRIMARY KEY, thread_id, provider, provider_thread_id, payload_json);
CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id PRIMARY KEY, driver);
INSERT INTO projection_projects VALUES ('project', '/work/root');
INSERT INTO orchestration_v2_projection_threads VALUES ('thread', 'project', 'codex', NULL, '{"worktreePath":"/work/tree"}');
INSERT INTO orchestration_v2_projection_threads VALUES ('deleted', 'project', 'codex', '2026-11-24', '{}');
INSERT INTO orchestration_v2_projection_provider_threads VALUES ('provider', 'pi');
INSERT INTO orchestration_v2_projection_runs VALUES ('run', 'thread', 'pi', 'provider', '{"workspacePreparation":{"type":"root"}}');
`;

const prefix = '[pi-lens automated check — not a user request]';
const submittedAt = '2026-11-23T07:23:39.207Z';

function insert(messages) {
  return messages.map(([id, payload, thread = 'thread']) => {
    const message = JSON.stringify({ createdBy: 'user', creationSource: 'web', ...payload }).replaceAll("'", "''");
    return `INSERT INTO orchestration_v2_projection_messages VALUES ('${id}', '${thread}', 'run', 'user', '${submittedAt}', '${message}');`;
  }).join('\n');
}

async function withT3(run) {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-submission-'));
  try {
    await mkdir(join(directory, 'userdata'));
    const db = join(directory, 'userdata', 'statev2.sqlite');
    const sql = text => execFileSync('sqlite3', [db], { input: text });
    sql(schema);
    await run(directory, sql);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('accepts T3 submissions by author and message ID, independent of text and provider context', async () => withT3(async (directory, sql) => {
  const attachment = { id: 'thread-image', name: 'image.png', mimeType: 'image/png' };
  const context = { version: 1, records: [
    { kind: 'image', attachmentId: 'thread-image', contextId: 'image_one' },
    { kind: 'image', attachmentId: 'thread-image', contextId: 'image_two' },
    { kind: 'file', attachmentId: 'thread-image', contextId: 'file_one' },
  ] };
  sql(insert([
    ['first', { text: '继续', context: { handoff: 'Context handoff (full_thread_summary): prior thread' } }],
    ['second', { text: '继续', creationSource: 'mobile' }],
    ['pasted', { text: `${prefix}\n原样引用\n` }],
    ['image', { text: '', context, attachments: [attachment, { id: '../outside', mimeType: 'image/png' }] }],
    ['handoff', { text: 'Context handoff (full_thread_summary): old\n继续', createdBy: 'agent', creationSource: 'provider' }],
    ['title', { text: '继续', createdBy: 'agent', creationSource: 'server' }],
    ['notification', { text: prefix, notification: {} }],
    ['compaction', { text: '总结', idleCompaction: {} }],
    ['agent', { text: prefix, createdBy: 'agent', creationSource: 'web' }],
    ['unknown', { text: prefix, creationSource: 'server' }],
    ['blank', { text: '   ' }],
    ['deleted-message', { text: 'deleted' }, 'deleted'],
  ]));
  const records = await readT3Submissions(directory);
  assert.deepEqual(records.map(row => row.messageId), ['first', 'image', 'pasted', 'second']);
  assert.equal(records[0].submittedAt, submittedAt);
  assert.equal(records[0].cwd, '/work/root');
  assert.equal(records[0].projectRoot, '/work/root');
  assert.equal(records[0].agent, 'pi');
  assert.equal(records[0].text, '继续');
  assert.equal(records[1].text, '');
  assert.deepEqual(records[1].attachments, [{ ...attachment, refs: ['image_one', 'image_two'] }]);
  assert.equal(records[2].text, `${prefix}\n原样引用\n`);
  assert.equal(records[3].text, records[0].text);
  assert.notEqual(records[3].id, records[0].id);
}));

test('keeps workspace and run attribution separate from current thread defaults', async () => withT3(async (directory, sql) => {
  sql(insert([['first', { text: 'from worktree' }], ['second', { text: 'waiting for agent' }]]));
  sql(`
    UPDATE orchestration_v2_projection_runs SET provider = 'magpie-codex', provider_thread_id = NULL, payload_json = '{}';
    UPDATE orchestration_v2_projection_threads SET default_provider = 'pi' WHERE thread_id = 'thread';
    UPDATE orchestration_v2_projection_messages SET run_id = NULL WHERE message_id = 'second';
  `);
  const [first, second] = await readT3Submissions(directory);
  assert.equal(first.agent, 'codex');
  assert.equal(first.cwd, '/work/tree');
  assert.equal(first.projectRoot, '/work/root');
  assert.equal(second.agent, null);
}));

test('snapshot rebuilds idempotently and keeps identity across provider changes', async () => withT3(async (directory, sql) => {
  assert.deepEqual(await readT3Submissions(directory), []);
  sql(insert([['submitted', { text: '继续' }]]));
  const [before] = await readT3Submissions(directory);
  await writeSubmissions(directory, [before]);
  const path = join(directory, '.submissions.json');
  const bytes = await readFile(path, 'utf8');
  await writeSubmissions(directory, [...await readT3Submissions(directory), before]);
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  sql("UPDATE orchestration_v2_projection_provider_threads SET driver = 'codex';");
  const [after] = await readT3Submissions(directory);
  assert.equal(after.id, before.id);
  await writeSubmissions(directory, [before, after]);
  assert.deepEqual(await readSubmissions(directory), [after]);
  assert.equal((await loadRecords(directory))[0].agent, 'codex');
}));
