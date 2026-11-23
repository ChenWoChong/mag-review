import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecords } from '../records.js';
import { writeRecords } from './fixtures.mjs';

test('project identity uses repository roots and preserves distinct missing paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diary-projects-'));
  try {
    const repo = join(directory, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'nested'));
    const records = [repo, join(repo, 'nested'), '/missing/a/repo', '/missing/b/repo'].map((cwd, i) => ({ id: String(i + 1).repeat(64), time: `2026-01-01T10:0${i}:00`, text: `prompt ${i}`, cwd, agent: 'codex' }));
    await writeRecords(directory, records);
    const loaded = await loadRecords(directory);
    const root = loaded.find(r => r.cwd === repo), nested = loaded.find(r => r.cwd === join(repo, 'nested'));
    assert.equal(root.projectId, nested.projectId);
    assert.equal(root.projectId, `path:${await realpath(repo)}`);
    assert.notEqual(loaded.find(r => r.cwd === '/missing/a/repo').projectId, loaded.find(r => r.cwd === '/missing/b/repo').projectId);
    assert.equal(loaded.find(r => r.cwd === '/missing/a/repo').projectKind, 'unconfirmed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('project identity resolves symlinked directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diary-symlink-'));
  try {
    const repo = join(directory, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    const linked = join(directory, 'linked');
    await symlink(repo, linked, 'dir');
    const records = [linked, repo].map((cwd, i) => ({ id: String(i + 1).repeat(64), time: `2026-01-01T10:0${i}:00`, text: `prompt ${i}`, cwd, agent: 'codex' }));
    await writeRecords(directory, records);
    const loaded = await loadRecords(directory);
    assert.equal(loaded[0].projectId, loaded[1].projectId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
