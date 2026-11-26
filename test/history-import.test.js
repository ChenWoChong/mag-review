import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importHistory } from '../scripts/history-import.js';
import { createDiaryServer } from '../server.js';
import { onRequest } from '../prompt.hooks.js';
import { verifyStore } from '../submissions.js';

const time = '2026-01-04T12:00:00Z';
const line = (text, extra = {}) => ({ role: 'user', harness: 'pi', session_id: 'pi-session', time, project: 'archive-project', text, ...extra });
const fixture = (...rows) => (_work, output) => writeFile(join(output, 'deja-sync-fixture.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));

test('imports deja-vu history independently and keeps stable IDs for published records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-native-history-test-'));
  const server = createDiaryServer({ directory });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const page = async path => {
      const response = await fetch(url + path);
      assert.equal(response.status, 200);
      return response.text();
    };
    onRequest({ input: 'Live prompt' }, { origin: 'local', protocol: 'responses', agent: 'pi', session: 'pi-session', options: { directory } });
    const exportHistory = fixture(line('Repeated text'), line('Repeated text'),
      line('Repeated text', { time: '2026-01-04T12:01:00Z' }),
      line('Codex historical **Markdown**', { harness: 'codex', session_id: 'codex-session' }),
      line('Context handoff (full_thread_summary):\nProvider context handoff.'),
      line('From a child', { kind: 'subagent' }), line('Assistant reply', { role: 'assistant' }));
    const preview = await importHistory(directory, { exportHistory });
    assert.deepEqual([preview.applied, preview.added, preview.skipped], [false, 3, 3]);
    assert(!((await readdir(directory)).includes('native-history.sqlite')));
    const result = await importHistory(directory, { apply: true, exportHistory });
    assert.equal(result.added, 3);
    assert.equal((await importHistory(directory, { apply: true, exportHistory })).added, 0);
    assert.deepEqual(await importHistory(directory, { apply: true, ifMissing: true, exportHistory: () => { assert.fail('export ran again'); } }), { alreadyImported: true });
    const timeline = await page('/?project=history%3Aarchive-project&q=Repeated%20text');
    assert.equal((timeline.match(/<article class="card">/g) || []).length, 2);
    assert.match(timeline, /本机历史导入 · deja-vu/);
    assert.match(await page('/?agent=codex'), /<strong>Markdown<\/strong>/);
    assert.doesNotMatch(await page('/'), /Provider context handoff|From a child|Assistant reply/);
    await assert.rejects(importHistory(directory, { apply: true, exportHistory: (_work, output) =>
      writeFile(join(output, 'deja-sync-invalid.jsonl'), 'broken') }), /Invalid JSON/);
    assert.match(await page('/'), /Live prompt/);
    assert.match(await page('/'), /Repeated text/);
    assert.equal(verifyStore(directory).prompts, 1);
    assert.equal(verifyStore(directory).missingCapture, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
