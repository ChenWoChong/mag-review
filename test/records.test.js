import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecords } from '../records.js';
import { eventKey, hashText } from '../identity.js';

const row = (id, time, text) => `<!-- magpie-prompt:${id.repeat(64)} -->\n## ${time} · t3code · /work\n\n\`\`\`text\n${text}\n\`\`\`\n`;

test('reconciles old retries by native message identity, preserving a real repeat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diary-reconcile-'));
  try {
    const session = 'same-session', text = '同一段话';
    const first = { time: new Date(2026, 10, 22, 11, 18, 41).toISOString(), event: 'msg-first' };
    const second = { time: new Date(2026, 10, 22, 11, 30, 0).toISOString(), event: 'msg-second' };
    const anchors = [first, second].map(event => ({ session: hashText(session), text: hashText(text), time: event.time, id: eventKey(session, event) }));
    await writeFile(join(directory, '.history.json'), JSON.stringify({ version: 1, records: [], anchors }));
    await writeFile(join(directory, '2026-11-22.md'), row('a', '11:18:41', text) + row('b', '11:24:41', text) + row('c', '11:30:00', text));
    const usage = join(directory, 'usage.jsonl');
    await writeFile(usage, ['11:18:41', '11:24:41', '11:30:00'].map(time => JSON.stringify({ agent: 't3code', session, t: `2026-11-22T${time}` })).join('\n'));
    const { records } = await loadRecords(directory, { usagePath: usage });
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(r => r.time), ['11:30:00', '11:18:41']);
    assert.deepEqual(records[1].aliases, ['b'.repeat(64)]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('same text in different sessions stays separate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diary-sessions-'));
  try {
    const text = '同一段话';
    const event = { time: new Date(2026, 10, 22, 11, 0, 0).toISOString(), event: 'message' };
    const anchors = ['one', 'two'].map(session => ({ session: hashText(session), text: hashText(text), time: event.time, id: eventKey(session, event) }));
    await writeFile(join(directory, '.history.json'), JSON.stringify({ version: 1, records: [], anchors }));
    await writeFile(join(directory, '2026-11-22.md'), row('a', '11:00:00', text) + row('b', '11:01:00', text));
    const usage = join(directory, 'usage.jsonl');
    await writeFile(usage, [JSON.stringify({ agent: 't3code', session: 'one', t: '2026-11-22T11:00:00' }), JSON.stringify({ agent: 't3code', session: 'two', t: '2026-11-22T11:01:00' })].join('\n'));
    assert.equal((await loadRecords(directory, { usagePath: usage })).records.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('project identity uses repository roots and preserves distinct missing paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diary-projects-'));
  try {
    const repo = join(directory, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'nested'));
    const records = [repo, join(repo, 'nested'), '/missing/a/repo', '/missing/b/repo'].map((cwd, i) => ({ id: String(i + 1).repeat(64), time: `2026-01-01T10:0${i}:00`, text: `prompt ${i}`, cwd, agent: 'codex' }));
    await writeFile(join(directory, '.history.json'), JSON.stringify({ version: 1, records }));
    const loaded = (await loadRecords(directory)).records;
    const root = loaded.find(r => r.cwd === repo), nested = loaded.find(r => r.cwd === join(repo, 'nested'));
    assert.equal(root.projectId, nested.projectId);
    assert.equal(root.projectKind, 'git');
    assert.notEqual(loaded.find(r => r.cwd === '/missing/a/repo').projectId, loaded.find(r => r.cwd === '/missing/b/repo').projectId);
    assert.equal(loaded.find(r => r.cwd === '/missing/a/repo').projectKind, 'unconfirmed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('project identity resolves symlinked directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diary-symlink-'));
  try {
    const repo = join(directory, 'repo');
    const link = join(directory, 'linked');
    await mkdir(join(repo, '.git'), { recursive: true });
    await symlink(repo, link, 'dir');
    const records = [repo, link].map((cwd, i) => ({ id: String(i + 1).repeat(64), time: `2026-01-01T10:0${i}:00`, text: `prompt ${i}`, cwd, agent: 'codex' }));
    await writeFile(join(directory, '.history.json'), JSON.stringify({ version: 1, records }));
    const loaded = (await loadRecords(directory)).records;
    assert.equal(loaded.find(r => r.cwd === repo).projectId, loaded.find(r => r.cwd === link).projectId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
