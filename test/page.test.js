import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { createDiaryServer } from '../server.js';

async function withServer(run) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-diary-page-'));
  const server = createDiaryServer({ directory });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(directory, url); } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('shows daily Markdown with date navigation and escapes prompt text', async () => withServer(async (directory, url) => {
  await writeFile(join(directory, '2026-11-20.md'), 'older');
  await writeFile(join(directory, '2026-11-21.md'), '<script>alert(1)</script>\n## latest');
  const response = await fetch(url);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /2026-11-20/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  const older = await (await fetch(`${url}/?date=2026-11-20`)).text();
  assert.match(older, /older/);
  assert.doesNotMatch(older, /alert/);
}));

test('empty state and invalid or unavailable dates', async () => withServer(async (_directory, url) => {
  assert.match(await (await fetch(url)).text(), /还没有记录/);
  assert.equal((await fetch(`${url}/?date=../../etc/passwd`)).status, 400);
  assert.equal((await fetch(`${url}/?date=2026-11-21`)).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  const status = await new Promise((resolve, reject) => {
    get(url, { headers: { host: 'attacker.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
}));

test('renders separate cards and saved images while preserving original copy text', async () => withServer(async (directory, url) => {
  const { onRequest } = await import('../prompt.hooks.js');
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aS8AAAAASUVORK5CYII=';
  const ctx = { origin: 'local', agent: 'codex', session: 'page-test', cwd: '/tmp', query: '看看图片\n换行', options: { directory } };
  await onRequest({ input: [{ role: 'user', content: [{ type: 'input_text', text: ctx.query }, { type: 'input_image', image_url: `data:image/png;base64,${image}` }] }] }, ctx);
  const ctx2 = { ...ctx, query: '没有图片 <hello>' };
  await onRequest({ input: [{ role: 'user', content: [{ type: 'input_text', text: ctx.query }] }, { role: 'user', content: [{ type: 'input_text', text: ctx2.query }] }] }, ctx2);
  const response = await fetch(url);
  const html = await response.text();
  assert.equal((html.match(/<article class="card">/g) || []).length, 2);
  assert.match(html, /data-copy="看看图片\n换行"/);
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.match(html, /没有图片 &lt;hello&gt;/);
  assert.match(response.headers.get('content-security-policy'), /img-src data:/);
}));

test('shows imported dates and merges matching live records without removing them', async () => withServer(async (directory, url) => {
  const stamp = new Date(2026, 0, 2, 10, 0, 0).toISOString();
  await writeFile(join(directory, '.history.json'), JSON.stringify({ version: 1, sessions: 1, read: 1, records: [{ time: stamp, text: '重复内容', cwd: '/work', images: [] }] }));
  await writeFile(join(directory, '2026-01-02.md'), `<!-- magpie-prompt:${'a'.repeat(64)} -->\n## 10:01:00 · codex · /work\n\n\`\`\`text\n重复内容\n\`\`\`\n`);
  const response = await fetch(url);
  const html = await response.text();
  assert.match(html, /2026-01-02/);
  assert.equal((html.match(/<article class="card">/g) || []).length, 1);
  assert.match(html, /刷新历史/);
}));
