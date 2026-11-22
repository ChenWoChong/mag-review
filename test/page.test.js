import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { runInNewContext } from 'node:vm';
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
  assert.match(await (await fetch(`${url}/?date=2026-11-21`)).text(), /这里还没有记录/);
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
  const nativeEvent = 'f'.repeat(64);
  await writeFile(join(directory, '.history.json'), JSON.stringify({ version: 1, sessions: 1, read: 1, records: [{ id: 'b'.repeat(64), nativeEvent, time: stamp, text: '重复内容', cwd: '/work', images: [] }] }));
  await writeFile(join(directory, '2026-01-02.md'), `<!-- magpie-prompt:${'a'.repeat(64)} -->\n## 10:01:00 · codex · /work\n\n\`\`\`text\n重复内容\n\`\`\`\n<!-- magpie-event:${nativeEvent} -->\n`);
  const response = await fetch(url);
  const html = await response.text();
  assert.match(html, /2026-01-02/);
  assert.equal((html.match(/<article class="card">/g) || []).length, 1);
  assert.match(html, /刷新历史/);
}));

test('filters records and keeps favorites and tags locally with a protected action', async () => withServer(async (directory, url) => {
  const id = 'b'.repeat(64);
  await writeFile(join(directory, '2026-01-02.md'), `<!-- magpie-prompt:${id} -->\n## 10:00:00 · codex · /work/project-one\n\n\`\`\`text\n第一条\n\`\`\`\n`);
  const page = await (await fetch(url)).text();
  const token = /<body data-token="([a-f0-9]+)"/.exec(page)[1];
  const send = (payload, origin = 'null') => fetch(`${url}/action`, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: JSON.stringify({ ...payload, token }) });
  assert.equal((await send({ type: 'favorite', ids: [id], value: true }, 'https://other.example')).status, 403);
  assert.equal((await send({ type: 'favorite', ids: [id], value: true })).status, 200);
  assert.equal((await send({ type: 'tag', ids: [id], tag: '代码审查', value: true })).status, 200);
  const favorite = await (await fetch(`${url}/?view=favorites&agent=codex&project=project-one&tag=${encodeURIComponent('代码审查')}`)).text();
  assert.match(favorite, /第一条/);
  assert.match(favorite, /代码审查/);
  assert.match(favorite, /网关实时记录/);
  const other = await (await fetch(`${url}/?agent=pi`)).text();
  assert.doesNotMatch(other, /第一条/);
  assert.equal((await send({ type: 'hidden', ids: [id], value: true })).status, 200);
  assert.doesNotMatch(await (await fetch(url)).text(), /第一条/);
  assert.match(await (await fetch(`${url}/?view=hidden`)).text(), /第一条/);
  assert.equal((await send({ type: 'hidden', ids: [id], value: false })).status, 200);
  assert.match(await (await fetch(url)).text(), /第一条/);
}));

test('preserves existing favorites when live and historical records merge', async () => withServer(async (directory, url) => {
  const live = 'c'.repeat(64), imported = 'd'.repeat(64), nativeEvent = 'f'.repeat(64);
  await writeFile(join(directory, '2026-01-02.md'), `<!-- magpie-prompt:${live} -->\n## 10:01:00 · codex · /work\n\n\`\`\`text\n保留收藏\n\`\`\`\n<!-- magpie-event:${nativeEvent} -->\n`);
  await writeFile(join(directory, '.history.json'), JSON.stringify({ version: 1, sessions: 1, read: 1, records: [{ id: imported, nativeEvent, time: new Date(2026, 0, 2, 10, 0, 0).toISOString(), text: '保留收藏', cwd: '/work', agent: 'codex' }] }));
  await writeFile(join(directory, '.annotations.json'), JSON.stringify({ version: 1, entries: { [live]: { favorite: true, tags: ['重要'], hidden: false } }, pinned: [] }));
  const page = await (await fetch(`${url}/?view=favorites`)).text();
  assert.match(page, /保留收藏/);
  assert.equal((page.match(/<article class="card">/g) || []).length, 1);
  assert.match(page, /取消收藏/);
  assert.match(page, /重要/);
  const token = /<body data-token="([a-f0-9]+)"/.exec(page)[1];
  const r = await fetch(`${url}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: JSON.stringify({ type: 'favorite', ids: [live, imported], value: false, token }) });
  assert.equal(r.status, 200);
  assert.doesNotMatch(await (await fetch(`${url}/?view=favorites`)).text(), /保留收藏/);
}));

test('saves and edits a reusable prompt template without changing the original', async () => withServer(async (directory, url) => {
  const id = 'e'.repeat(64);
  await writeFile(join(directory, '2026-01-02.md'), `<!-- magpie-prompt:${id} -->\n## 10:00:00 · codex · /work/project\n\n\`\`\`text\n检查项目 project\n\`\`\`\n`);
  const page = await (await fetch(url)).text();
  const token = /<body data-token="([a-f0-9]+)"/.exec(page)[1];
  const send = (payload) => fetch(`${url}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: JSON.stringify({ ...payload, token }) });
  assert.equal((await send({ type: 'template-save', id, title: '检查项目', text: '检查项目 {项目名}' })).status, 200);
  const template = await (await fetch(`${url}/?view=templates`)).text();
  assert.match(template, /检查项目 \{项目名\}/);
  assert.match(await (await fetch(url)).text(), /检查项目 project/);
  assert.equal((await send({ type: 'template-delete', id })).status, 200);
  assert.doesNotMatch(await (await fetch(`${url}/?view=templates`)).text(), /检查项目 \{项目名\}/);
  assert.match(await (await fetch(url)).text(), /检查项目 project/);
}));

test('activity calendar shows one selected month and handles leap years', async () => withServer(async (_directory, url) => {
  const html = await (await fetch(`${url}/?month=2024-02`)).text();
  assert.equal((html.match(/class="heat level-/g) || []).length, 29);
  assert.match(html, /2024 年 2 月/);
  assert.match(html, /month=2024-01/);
  assert.match(html, /month=2024-03/);
  assert.doesNotMatch(html, /3个月|6个月/);
}));


test('follows Magpie theme updates and ignores other windows', async () => withServer(async (_directory, url) => {
  const html = await (await fetch(url)).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const properties = new Map();
  const root = { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) } };
  let listener, request;
  const parent = { postMessage: message => { request = message; } };
  const window = { parent, addEventListener: (_event, callback) => { listener = callback; } };
  const document = { documentElement: root, querySelector: () => null, addEventListener: () => {} };
  runInNewContext(script, { window, document, setTimeout });
  assert.equal(request.method, 'theme');
  listener({ source: parent, data: { magpie: 1, id: request.id, result: { dark: false, tokens: { bg: '#fff' } } } });
  assert.equal(root.dataset.theme, 'light');
  assert.equal(properties.get('--magpie-bg'), '#fff');
  listener({ source: {}, data: { magpie: 1, event: 'theme', data: { dark: true } } });
  assert.equal(root.dataset.theme, 'light');
  listener({ source: parent, data: { magpie: 1, event: 'theme', data: { dark: true, tokens: { bg: '#111' } } } });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.style.colorScheme, 'dark');
  assert.equal(properties.get('--magpie-bg'), '#111');
}));
