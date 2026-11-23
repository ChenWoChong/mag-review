import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createDiaryServer } from '../server.js';
import { submission, writeSubmissions } from '../submissions.js';
import { writeRecords } from './fixtures.mjs';

async function withServer(run, options = {}, dependencies = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-diary-page-'));
  const server = createDiaryServer({ directory, ...options }, dependencies);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(directory, url); } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('shows confirmed submissions by date and escapes prompt text', async () => withServer(async (directory, url) => {
  await writeRecords(directory, [
    { id: 'old', time: '2026-11-20T12:00:00', text: 'older' },
    { id: 'new', time: '2026-11-21T12:00:00', text: '<script>alert(1)</script>\n## latest' },
  ]);
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

test('renders attachment-only submissions and preserves original copy text', async () => {
  const t3DataDirectory = await mkdtemp(join(tmpdir(), 'diary-attachments-'));
  try {
    const root = join(t3DataDirectory, 'userdata', 'attachments');
    await mkdir(root, { recursive: true });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aS8AAAAASUVORK5CYII=', 'base64');
    await writeFile(join(root, 'thread-image.png'), bytes);
    await writeFile(join(root, 'thread-other.png'), bytes);
    const attachments = [
      { id: 'thread-other', name: 'image.png', mimeType: 'image/png' },
      { id: 'thread-image', name: 'image.png', mimeType: 'image/png', refs: ['image_second'] },
    ];
    const reference = '![image.png](t3-context://v1/image/image_second)';
    const context = '<t3_context version="1">\n<context kind="image" id="image_first">\nname: image.png\nattachmentId: thread-other\n</context>\n</t3_context>';
    const path = '[Attached image "image.png" is saved at: /t3/userdata/attachments/thread-other.png]';
    const text = `看看图片 ${reference}\n\`[Image: image.png; ref=image_second]\`\n${context}\n${path}`;
    const base = { source: 't3code', session: 'thread', submittedAt: new Date().toISOString() };
    const records = [
      submission({ ...base, messageId: 'image', text: '', attachments: [attachments[0]] }),
      submission({ ...base, messageId: 'text', text, attachments }),
    ];
    await withServer(async (directory, url) => {
      await writeSubmissions(directory, records);
      const response = await fetch(url);
      const html = await response.text();
      assert.equal((html.match(/<article class="card">/g) || []).length, 2);
      const prompt = /<div class="prompt">([\s\S]*?)<\/div>/.exec(html)[1];
      assert.match(prompt, /data-image-id="thread-image"[^>]*>image\.png<\/button>/);
      assert.match(prompt, /<code>\[Image: image\.png; ref=image_second\]<\/code>/);
      assert.doesNotMatch(prompt, /t3-context:\/\/|t3_context|is saved at/);
      assert.match(html, /data-image-id="thread-other"[^>]*>image\.png<\/button>/);
      assert.match(html, /data-copy="看看图片 !\[image\.png\]\(t3-context:\/\/v1\/image\/image_second\)/);
      assert.match(html, /<div class="pictures" hidden><button[^>]*aria-label="放大查看图片"[^>]*><img src="data:image\/png;base64,/);
      assert.match(html, /<dialog class="image-dialog" aria-label="图片预览">/);
      assert.match(response.headers.get('content-security-policy'), /img-src data:/);
    }, { t3DataDirectory }, { readSource: async () => records });
  } finally { await rm(t3DataDirectory, { recursive: true, force: true }); }
});

test('legacy records stay outside the diary even when the confirmed timeline is empty', async () => withServer(async (directory, url) => {
  await writeFile(join(directory, '2026-01-02.md'), '网关交接摘要');
  await writeFile(join(directory, '.history.json'), JSON.stringify({ version: 1, records: [{ text: '原生交接摘要' }] }));
  const response = await fetch(`${url}/?date=2026-01-02`);
  const html = await response.text();
  assert.match(html, /这里还没有记录/);
  assert.doesNotMatch(html, /交接摘要/);
}));

test('filters records and keeps favorites and tags locally with a protected action', async () => withServer(async (directory, url) => {
  const id = 'b'.repeat(64);
  await writeRecords(directory, [{ id, time: '2026-01-02T10:00:00', agent: 'codex', cwd: '/work/project-one', text: '第一条' }]);
  const page = await (await fetch(url)).text();
  const token = /<body data-token="([a-f0-9]+)"/.exec(page)[1];
  const send = (payload, origin = 'null') => fetch(`${url}/action`, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: JSON.stringify({ ...payload, token }) });
  assert.equal((await send({ type: 'favorite', ids: [id], value: true }, 'https://other.example')).status, 403);
  assert.equal((await send({ type: 'favorite', ids: [id], value: true })).status, 200);
  assert.equal((await send({ type: 'tag', ids: [id], tag: '代码审查', value: true })).status, 200);
  const favorite = await (await fetch(`${url}/?view=favorites&agent=codex&project=project-one&tag=${encodeURIComponent('代码审查')}`)).text();
  assert.match(favorite, /第一条/);
  assert.match(favorite, /代码审查/);
  assert.match(favorite, /T3 Code 用户提交/);
  const other = await (await fetch(`${url}/?agent=pi`)).text();
  assert.doesNotMatch(other, /第一条/);
  assert.equal((await send({ type: 'hidden', ids: [id], value: true })).status, 200);
  assert.doesNotMatch(await (await fetch(url)).text(), /第一条/);
  assert.match(await (await fetch(`${url}/?view=hidden`)).text(), /第一条/);
  assert.equal((await send({ type: 'hidden', ids: [id], value: false })).status, 200);
  assert.match(await (await fetch(url)).text(), /第一条/);
}));

test('keeps favorites when the same submission is synchronized again', async () => withServer(async (directory, url) => {
  const id = 'c'.repeat(64);
  const record = { id, time: '2026-01-02T10:00:00', text: '保留收藏', cwd: '/work', agent: 'codex' };
  await writeRecords(directory, [record]);
  await writeFile(join(directory, '.annotations.json'), JSON.stringify({ version: 1, entries: { [id]: { favorite: true, tags: ['重要'], hidden: false } }, pinned: [] }));
  await writeRecords(directory, [record, { ...record, agent: 'pi' }]);
  const page = await (await fetch(`${url}/?view=favorites`)).text();
  assert.match(page, /保留收藏/);
  assert.equal((page.match(/<article class="card">/g) || []).length, 1);
  assert.match(page, /取消收藏/);
  assert.match(page, /重要/);
}));

test('saves and edits a reusable prompt template without changing the original', async () => withServer(async (directory, url) => {
  const id = 'e'.repeat(64);
  await writeRecords(directory, [{ id, time: '2026-01-02T10:00:00', cwd: '/work/project', text: '检查项目 project\n' }]);
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
  const window = { parent, addEventListener: (event, callback) => { if (event === 'message') listener = callback; } };
  const document = { documentElement: root, querySelector: () => null, addEventListener: () => {} };
  runInNewContext(script, { window, document, setTimeout, location: { pathname: '/', search: '' } });
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


test('time ranges combine with categories and calendar selection clears the range', async () => withServer(async (directory, url) => {
  const atDaysAgo = days => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - days); return d; };
  const records = [0, 6, 35].map((days, i) => ({ id: String(i + 1).repeat(64), time: atDaysAgo(days).toISOString(), text: `范围记录${i}`, cwd: '/work', agent: 'codex' }));
  await writeRecords(directory, records);
  await writeFile(join(directory, '.annotations.json'), JSON.stringify({ version: 1, entries: { [records[0].id]: { favorite: true, tags: [], hidden: false } }, pinned: [] }));
  const today = await (await fetch(`${url}/?range=today`)).text();
  assert.match(today, /范围记录0/);
  assert.doesNotMatch(today, /范围记录1/);
  assert.match(today, /选择时间范围">当天/);
  assert.doesNotMatch(today, /颜色表示当天已收录的记录|统计仅包含已收录的记录|已读取 1\/1 个会话/);
  const last7 = await (await fetch(`${url}/?range=last-7`)).text();
  assert.match(last7, /范围记录0/);
  assert.match(last7, /范围记录1/);
  assert.doesNotMatch(last7, /范围记录2/);
  const favorites = await (await fetch(`${url}/?range=last-7&view=favorites`)).text();
  assert.match(favorites, /范围记录0/);
  assert.doesNotMatch(favorites, /范围记录1/);
  const month = await (await fetch(`${url}/?range=month`)).text();
  assert.doesNotMatch(month, /范围记录2/);
  const week = await (await fetch(`${url}/?range=this-week`)).text();
  assert.match(week, /范围记录0/);
  const nav = /<nav class="navigation"[^>]*>(.*?)<\/nav>/.exec(last7)[1];
  assert.equal((nav.match(/class="nav-item/g) || []).length, 3);
  assert.match(last7, /选择时间范围/);
  const calendar = /<div class="heatmap">(.*?)<\/div>/.exec(last7)[1];
  assert.doesNotMatch(calendar, /range=last-7/);
}));


test('filters without navigation using a protected local request', async () => withServer(async (_directory, url) => {
  const page = await (await fetch(url)).text();
  const token = /<body data-token="([a-f0-9]+)"/.exec(page)[1];
  const send = (body, origin = 'null') => fetch(`${url}/filter`, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: JSON.stringify(body) });
  assert.equal((await send({ token: 'invalid', path: '/?range=today' })).status, 403);
  assert.equal((await send({ token, path: '/?range=today' }, 'https://other.example')).status, 403);
  assert.equal((await send({ token, path: '//other.example/' })).status, 400);
  const response = await send({ token, path: '/?range=today' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'null');
  const filtered = await response.text();
  assert.match(filtered, /选择时间范围">当天/);
  assert.doesNotMatch(filtered, /<h1>Prompt 日记<\/h1>/);
}));


test('time selection replaces content without navigating and preserves sidebar state', async () => withServer(async (_directory, url) => {
  const html = await (await fetch(url)).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const events = {}, menu = { open: true, contains: () => true };
  const oldGroups = [{ id: 'project-filters', open: true }, { id: 'agent-filters', open: false }];
  const newGroups = [{ id: 'agent-filters', open: false }, { id: 'project-filters', open: false }];
  const oldSidebar = { scrollTop: 42, querySelectorAll: () => oldGroups, replaceWith: value => { assert.equal(value, newSidebar); } };
  const newSidebar = { scrollTop: 0, querySelectorAll: () => newGroups };
  const newMain = {}, oldMain = { querySelector: () => null, replaceWith: value => { assert.equal(value, newMain); } };
  const document = { body: { dataset: { token: 'secret' } }, querySelector: key => ({ '.range-menu': menu, '.sidebar': oldSidebar, '.main': oldMain })[key], addEventListener: (name, fn) => { events[name] = fn; } };
  const parent = { postMessage: () => {} }, window = { parent, addEventListener: () => {} };
  let navigated = false, request;
  const location = { pathname: '/', search: '', assign: () => { navigated = true; } };
  const history = { pushState: (_state, _title, path) => { assert.equal(path, '/?range=today'); } };
  const page = { querySelector: key => ({ '.sidebar': newSidebar, '.main': newMain })[key] };
  const fakeFetch = async (_url, options) => { request = JSON.parse(options.body); return { ok: true, text: async () => 'html' }; };
  class DOMParser { parseFromString() { return page; } }
  runInNewContext(script, { window, document, location, history, fetch: fakeFetch, DOMParser, URL, setTimeout, clearTimeout });
  let prevented = false;
  const option = { href: 'http://127.0.0.1:3479/?range=today' };
  const target = { closest: selector => selector === '.range-option, .local-filter' ? option : null };
  await events.click({ target, button: 0, preventDefault: () => { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(navigated, false);
  assert.equal(request.path, '/?range=today');
  assert.equal(newSidebar.scrollTop, 42);
  assert.deepEqual(newGroups.map(group => group.open), [false, true]);
}));


test('searches prompt text and sorts before pagination while retaining filters', async () => withServer(async (directory, url) => {
  const records = Array.from({ length: 35 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), time: new Date(2026, 0, 1, 12, i).toISOString(), text: `Needle ${String(i).padStart(2, '0')}`, cwd: '/work', agent: 'codex' }));
  records.push({ id: 'f'.repeat(64), time: new Date(2026, 0, 1, 13).toISOString(), text: '别的内容', cwd: '/work', agent: 'codex' });
  await writeRecords(directory, records);
  const asc = await (await fetch(`${url}/?q=NEEDLE&sort=asc`)).text();
  assert.match(asc, /35 条记录/);
  assert.match(asc, /Needle 00/);
  assert.doesNotMatch(asc, /Needle 34/);
  assert.doesNotMatch(asc, /别的内容/);
  assert.match(asc, /时间正序：最早在前/);
  const second = await (await fetch(`${url}/?q=needle&sort=asc&page=2`)).text();
  assert.match(second, /Needle 34/);
  assert.doesNotMatch(second, /Needle 00/);
  const desc = await (await fetch(`${url}/?q=needle`)).text();
  assert.ok(desc.indexOf('Needle 34') < desc.indexOf('Needle 33'));
  assert.match(desc, /时间倒序：最新在前/);
  assert.doesNotMatch(desc, /刷新历史/);
}));


test('navigates only the selected card images with buttons, keys and swipes', async () => withServer(async (_directory, url) => {
  const html = await (await fetch(url)).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const events = {}, preview = { src: '' }, prev = {}, next = {}, count = {};
  const elements = { img: preview, '.preview-prev': prev, '.preview-next': next, '.preview-count': count };
  const dialog = { open: false, querySelector: key => elements[key], showModal() { this.open = true; }, close() { this.open = false; } };
  const document = { body: { dataset: {} }, querySelector: key => key === '.image-dialog' ? dialog : null, addEventListener: (name, fn) => { const previous = events[name]; events[name] = previous ? event => { previous(event); fn(event); } : fn; } };
  const parent = { postMessage: () => {} }, window = { parent, addEventListener: () => {} };
  runInNewContext(script, { document, window, location: { pathname: '/', search: '' }, setTimeout, clearTimeout });
  const images = ['first', 'second'].map(src => ({ src, dataset: { galleryImage: src } }));
  const card = { querySelectorAll: selector => selector === '[data-gallery-image]' ? images : [] };
  const button = id => ({ dataset: { imageId: id }, classList: { contains: name => name === 'image-preview' }, closest: selector => selector === '.card' ? card : null });
  const click = target => events.click({ target: { closest: selector => selector === 'button' ? target : null } });
  await click(button('second'));
  assert.equal(dialog.open, true);
  assert.equal(preview.src, 'second');
  assert.equal(count.textContent, '2 / 2');
  assert.equal(next.disabled, true);
  assert.equal(prev.hidden, false);
  let prevented = false;
  events.keydown({ key: 'ArrowLeft', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(preview.src, 'first');
  assert.equal(prev.disabled, true);
  await click({ dataset: {}, classList: { contains: name => name === 'preview-next' } });
  assert.equal(preview.src, 'second');
  const target = { closest: () => dialog };
  events.touchstart({ target, touches: [{ clientX: 10, clientY: 10 }] });
  events.touchend({ target, changedTouches: [{ clientX: 90, clientY: 12 }] });
  assert.equal(preview.src, 'first');
  await events.click({ target: dialog });
  assert.equal(dialog.open, false);
}));

test('keeps literal T3 context markers in an explicitly submitted prompt', async () => withServer(async (directory, url) => {
  const text = '<t3_context version="1">\n<context kind="image" id="example">\nname: image.png\nmimeType: image/png\nattachmentId: example-id\n</context>\n</t3_context>';
  await writeRecords(directory, [{ id: 'a', time: new Date(), text }]);
  const html = await (await fetch(url)).text();
  const prompt = /<div class="prompt">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.match(prompt, /attachmentId: example-id/);
  assert.match(prompt, /&lt;t3_context version=&quot;1&quot;&gt;/);
  assert.match(html, /data-copy="&lt;t3_context/);
}));

test('review date and range form updates within the sandbox', async () => withServer(async (_directory, url) => {
  const html = await (await fetch(url)).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const events = {}, oldGroups = [], newGroups = [];
  const nextSidebar = { scrollTop: 0, querySelectorAll: () => newGroups };
  const oldSidebar = { scrollTop: 0, querySelectorAll: () => oldGroups, replaceWith: () => {} };
  const nextMain = {}, oldMain = { querySelector: () => null, replaceWith: () => {} };
  const document = { body: { dataset: { token: 'secret' } }, querySelector: key => ({ '.sidebar': oldSidebar, '.main': oldMain })[key] || null, addEventListener: (name, fn) => { events[name] = fn; } };
  const parent = { postMessage: () => {} }, window = { parent, addEventListener: () => {} };
  const location = { pathname: '/', search: '?view=review', href: 'http://127.0.0.1:3479/?view=review', assign: () => { throw new Error('unexpected navigation'); } };
  let path;
  const fakeFetch = async (_url, options) => { path = JSON.parse(options.body).path; return { ok: true, text: async () => 'html' }; };
  class DOMParser { parseFromString() { return { querySelector: key => ({ '.sidebar': nextSidebar, '.main': nextMain })[key] }; } }
  const history = { pushState: () => {} };
  runInNewContext(script, { window, document, location, history, fetch: fakeFetch, DOMParser, URL, setTimeout, clearTimeout });
  const form = { matches: selector => selector === '.review-scope', querySelector: selector => ({ value: selector.includes('reviewDate') ? '2026-11-20' : 'weekly' }) };
  let prevented = false;
  events.submit({ target: form, preventDefault: () => { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(path, '/?view=review&reviewDate=2026-11-20&reviewKind=weekly');
}));

test('copies only selected prompt text after an explicit click', async () => withServer(async (_directory, url) => {
  const html = await (await fetch(url)).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const handlers = {}, text = '选中的文字';
  const prompt = {}, node = { nodeType: 1, closest: selector => selector === '.prompt' ? prompt : null };
  const selection = { isCollapsed: false, rangeCount: 1, anchorNode: node, focusNode: node, toString: () => text, getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 20, top: 80, bottom: 100, width: 100 }) }) };
  const button = { hidden: true, offsetWidth: 70, offsetHeight: 25, style: {}, dataset: {}, textContent: '', classList: { contains: name => name === 'selection-copy' }, closest: selector => selector === 'button' || selector === '.selection-copy' ? button : null };
  const document = { body: { dataset: {} }, querySelector: key => key === '.selection-copy' ? button : null, addEventListener: (name, fn) => { handlers[name] = fn; } };
  const parent = { postMessage: () => {} }, window = { parent, addEventListener: () => {}, getSelection: () => selection, innerWidth: 500, innerHeight: 500 };
  let copied = '';
  const navigator = { clipboard: { writeText: async value => { copied = value; } } };
  runInNewContext(script + '\nshowSelectionCopy();', { document, window, navigator, location: { pathname: '/', search: '' }, setTimeout: () => 1, clearTimeout: () => {} });
  assert.equal(button.hidden, false);
  assert.equal(copied, '');
  await handlers.click({ target: button });
  assert.equal(copied, text);
  assert.equal(button.textContent, '已复制');
}));

test('groups timeline cards by day and keeps controls outside collapsed cards', async () => withServer(async (directory, url) => {
  const records = [
    { id: 'a'.repeat(64), time: new Date(2026, 0, 2, 10).toISOString(), text: '第一天早上', cwd: '/work', agent: 'codex' },
    { id: 'b'.repeat(64), time: new Date(2026, 0, 2, 11).toISOString(), text: '第一天上午', cwd: '/work', agent: 'codex' },
    { id: 'c'.repeat(64), time: new Date(2026, 0, 3, 9).toISOString(), text: '第二天', cwd: '/work', agent: 'codex' },
  ];
  await writeRecords(directory, records);
  const page = await (await fetch(url)).text();
  assert.equal((page.match(/class="timeline-day"/g) || []).length, 2);
  assert.equal((page.match(/class="timeline-row"/g) || []).length, 3);
  assert.equal((page.match(/class="card-footer" hidden/g) || []).length, 3);
  assert.equal((page.match(/class="more timeline-actions"/g) || []).length, 3);
  assert.ok(page.indexOf('2026-01-03</h3>') < page.indexOf('2026-01-02</h3>'));
  assert.match(page, /<time class="timeline-time" datetime="2026-01-02T11:00:00">11:00:00<\/time><article class="card">/);
  assert.match(page, /class="toggle-card-info" aria-expanded="false">显示详情/);
  const ascending = await (await fetch(`${url}/?sort=asc`)).text();
  assert.ok(ascending.indexOf('2026-01-02</h3>') < ascending.indexOf('2026-01-03</h3>'));
}));

test('timeline menu toggles details and opens editors on its own card', async () => withServer(async (_directory, url) => {
  const html = await (await fetch(url)).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const handlers = {}, footer = { hidden: true }, pictures = { hidden: true, querySelectorAll: () => [{}, {}] }, input = { value: '', focus() {} }, textarea = { value: '' };
  const tagEditor = { hidden: true }, editor = { hidden: true, querySelector: selector => selector === 'input' ? input : textarea };
  const card = { querySelector: selector => ({ '.tag-editor': tagEditor, '.tag-editor input': input, '.template-editor': editor })[selector] };
  const menu = { open: true }, copy = { dataset: { copy: '完整原文' } };
  const row = { querySelector: selector => ({ '.card-footer': footer, '.pictures': pictures, '.card': card, '.copy': copy })[selector] };
  const document = { body: { dataset: {} }, querySelector: () => null, addEventListener: (name, fn) => { handlers[name] = fn; } };
  const parent = { postMessage() {} }, window = { parent, addEventListener() {} };
  runInNewContext(script, { document, window, location: { pathname: '/', search: '' }, setTimeout, clearTimeout });
  const button = name => ({ dataset: {}, textContent: '', setAttribute(key, value) { this[key] = value; }, classList: { contains: value => value === name }, closest: selector => ({ '.timeline-row': row, '.more': menu, 'details': menu, 'button': null })[selector] });
  const click = target => handlers.click({ target: { closest: selector => selector === 'button' ? target : null } });
  const toggle = button('toggle-card-info');
  await click(toggle);
  assert.equal(footer.hidden, false);
  assert.equal(pictures.hidden, false);
  assert.equal(toggle.textContent, '隐藏详情');
  assert.equal(toggle['aria-expanded'], 'true');
  assert.equal(menu.open, false);
  await click(toggle);
  assert.equal(footer.hidden, true);
  assert.equal(pictures.hidden, true);
  assert.equal(toggle['aria-expanded'], 'false');
  menu.open = true;
  await click(button('add-tag'));
  assert.equal(tagEditor.hidden, false);
  assert.equal(menu.open, false);
  await click(button('edit-template'));
  assert.equal(editor.hidden, false);
  assert.equal(textarea.value, '完整原文');
}));

test('closes an open card menu on outside click or Escape', async () => withServer(async (_directory, url) => {
  const html = await (await fetch(url)).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const handlers = {}, inside = {}, outside = { closest: () => null };
  let focused = false;
  const menu = { open: true, contains: element => element === inside, querySelector: () => ({ focus: () => { focused = true; } }) };
  const document = { body: { dataset: {} }, querySelector: () => null, querySelectorAll: selector => selector === '.timeline-actions[open]' && menu.open ? [menu] : [], addEventListener: (name, fn) => { handlers[name] = fn; } };
  const parent = { postMessage() {} }, window = { parent, addEventListener() {} };
  runInNewContext(script, { document, window, location: { pathname: '/', search: '' }, setTimeout, clearTimeout });
  await handlers.click({ target: outside });
  assert.equal(menu.open, false);
  menu.open = true;
  handlers.keydown({ key: 'Escape', target: outside });
  assert.equal(menu.open, false);
  assert.equal(focused, true);
}));

test('incremental loading uses a stable cursor when new records arrive', async () => withServer(async (directory, url) => {
  const records = Array.from({ length: 45 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), time: new Date(2026, 0, 1, 12, i).toISOString(), text: `记录${String(i).padStart(2, '0')}`, cwd: '/work', agent: 'codex' }));
  await writeRecords(directory, records);
  const first = await (await fetch(url)).text();
  const firstItems = [...first.matchAll(/data-copy="(记录\d+)"/g)].map(m => m[1]);
  assert.equal(firstItems.length, 30);
  assert.doesNotMatch(first, /上一页|下一页/);
  const next = /class="load-more-sentinel" data-next="([^"]+)"/.exec(first)[1].replaceAll('&amp;', '&');
  const token = /<body data-token="([a-f0-9]+)"/.exec(first)[1];
  records.push({ id: 'f'.repeat(64), time: new Date(2026, 0, 1, 12, 59).toISOString(), text: '新插入记录', cwd: '/work', agent: 'codex' });
  await writeRecords(directory, records);
  const response = await fetch(`${url}/filter`, { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: JSON.stringify({ token, path: next }) });
  const second = await response.text();
  const secondItems = [...second.matchAll(/data-copy="(记录\d+)"/g)].map(m => m[1]);
  assert.equal(secondItems.length, 15);
  assert.equal(new Set([...firstItems, ...secondItems]).size, 45);
  assert.doesNotMatch(second, /class="load-more-sentinel"/);
  assert.doesNotMatch(second, /新插入记录/);
  assert.match(await (await fetch(`${url}/?after=${'e'.repeat(64)}`)).text(), /记录已变化，请刷新页面后重试/);
}));

test('incremental loading merges the same date and appends later dates', async () => withServer(async (_directory, url) => {
  const html = await (await fetch(url)).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const appended = [], inserted = [], nextRows = [{ id: 'r1' }, { id: 'r2' }];
  const last = { dataset: { day: '2026-01-02' }, appendChild: row => appended.push(row) };
  const same = { dataset: { day: '2026-01-02' }, querySelectorAll: () => nextRows };
  const other = { dataset: { day: '2026-01-01' }, querySelectorAll: () => [] };
  const status = {}, retry = {}, sentinel = { dataset: { next: '/?after=123' }, isConnected: true, querySelector: key => key === 'span' ? status : retry, before: node => inserted.push(node), remove() { this.isConnected = false; } };
  const main = { querySelectorAll: () => [last], querySelector: () => null };
  const nextMain = { querySelectorAll: () => [same, other], querySelector: () => null };
  const document = { body: { dataset: { token: 'secret' } }, querySelector: key => key === '.main' ? main : null, addEventListener() {} };
  const parent = { postMessage() {} }, window = { parent, addEventListener() {} };
  class DOMParser { parseFromString() { return { querySelector: () => nextMain }; } }
  const fakeFetch = async () => ({ ok: true, text: async () => 'html' });
  await runInNewContext(script + '\nloadMore(sentinel)', { document, window, sentinel, DOMParser, fetch: fakeFetch, location: { pathname: '/', search: '' }, setTimeout, clearTimeout });
  assert.deepEqual(appended, nextRows);
  assert.deepEqual(inserted, [other]);
  assert.equal(sentinel.isConnected, false);
}));

test('highlights all literal search matches without changing copy text or HTML safety', async () => withServer(async (directory, url) => {
  const records = [
    { id: 'a'.repeat(64), time: new Date().toISOString(), text: '提交推送，推送完成\n推送', cwd: '/work', agent: 'codex' },
    { id: 'b'.repeat(64), time: new Date().toISOString(), text: 'A.b 和 a.B 以及 axb', cwd: '/work', agent: 'codex' },
    { id: 'c'.repeat(64), time: new Date().toISOString(), text: '示例 <script>alert(1)</script>', cwd: '/work', agent: 'codex' },
  ];
  await writeRecords(directory, records);
  const search = async text => (await (await fetch(`${url}/?q=${encodeURIComponent(text)}`)).text());
  const chinese = await search('推送');
  const body = /<div class="prompt">([\s\S]*?)<\/div>/.exec(chinese)[1];
  assert.equal((body.match(/<mark>推送<\/mark>/g) || []).length, 3);
  assert.match(chinese, /data-copy="提交推送，推送完成\n推送"/);
  const literal = await search('a.b');
  const literalBody = /<div class="prompt">([\s\S]*?)<\/div>/.exec(literal)[1];
  assert.match(literalBody, /<mark>A\.b<\/mark> 和 <mark>a\.B<\/mark> 以及 axb/);
  const unsafe = await search('<script>');
  assert.match(unsafe, /<mark>&lt;script&gt;<\/mark>/);
  assert.doesNotMatch(unsafe, /<script>alert/);
  const normal = await (await fetch(url)).text();
  const normalPrompt = /<div class="prompt">([\s\S]*?)<\/div>/.exec(normal)[1];
  assert.doesNotMatch(normalPrompt, /<mark>/);
}));

test('renders full card Markdown, highlights code and keeps the original source', async () => withServer(async (directory, url) => {
  const text = '# 设置\n\n先检查 `baseAgent` 和 **版本**。\n\n```yaml\nbaseAgent:\n  classes: {}\n```\n\n- 第一步\n- 第二步\n\n> 提醒\n\n| 键 | 值 |\n| --- | --- |\n| name | demo |\n\n[文档](https://example.com/docs)\n\n<img src="https://example.com/raw" onerror="alert(1)">\n\n![外部图片](https://example.com/remote.png)\n\n[危险链接](javascript:alert%281%29)';
  await writeRecords(directory, [{ id: 'markdown', time: new Date(), text }]);
  const html = await (await fetch(`${url}/?q=baseAgent`)).text();
  const prompt = /<div class="prompt">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.match(prompt, /<h1>设置<\/h1>/);
  assert.match(prompt, /<code><mark>baseAgent<\/mark><\/code>/);
  assert.match(prompt, /<strong>版本<\/strong>/);
  assert.match(prompt, /<pre><code class="language-yaml"><mark>baseAgent<\/mark>:\n  classes: \{\}/);
  assert.match(prompt, /<li>第一步<\/li>/);
  assert.match(prompt, /<blockquote>\s*<p>提醒<\/p>/);
  assert.match(prompt, /<table>[\s\S]*<td>demo<\/td>/);
  assert.match(prompt, /<a href="https:\/\/example\.com\/docs">文档<\/a>/);
  assert.match(prompt, /&lt;img src=/);
  assert.match(prompt, /外部图片/);
  assert.doesNotMatch(prompt, /<img|remote\.png|href="javascript:/);
  assert.match(html, /data-copy="# 设置\n\n先检查 `baseAgent` 和 \*\*版本\*\*。/);
}));

test('open menu stays open inside its area and closes after leaving', async () => withServer(async (_directory, url) => {
  const html = await (await fetch(url)).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const events = {}, timers = new Map(); let next = 0;
  const inside = {}, outside = {};
  const menu = { open: true, contains: item => item === inside };
  const target = { closest: selector => selector === '.timeline-actions' ? menu : null };
  const document = { body: { dataset: {} }, querySelector: () => null, addEventListener: (name, fn) => { events[name] = fn; } };
  const parent = { postMessage() {} }, window = { parent, addEventListener() {} };
  const setTimer = fn => { const id = ++next; timers.set(id, fn); return id; };
  runInNewContext(script, { document, window, location: { pathname: '/', search: '' }, setTimeout: setTimer, clearTimeout: id => timers.delete(id) });
  events.pointerout({ pointerType: 'mouse', target, relatedTarget: inside });
  assert.equal(timers.size, 0);
  events.pointerout({ pointerType: 'mouse', target, relatedTarget: outside });
  assert.equal(menu.open, true);
  events.pointerover({ target });
  assert.equal(timers.size, 0);
  events.pointerout({ pointerType: 'mouse', target, relatedTarget: outside });
  for (const fn of [...timers.values()]) fn();
  assert.equal(menu.open, false);
}));

test('submission sync does not reload the page and signals when it finishes', async () => {
  let finish, reads = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const readSource = () => { reads++; return pending; };
  await withServer(async (_directory, url) => {
    const page = await (await fetch(url)).text();
    assert.match(page, /正在同步历史记录/);
    assert.doesNotMatch(page, /setTimeout\(\(\) => location\.reload\(\), 3000\)/);
    const token = /<body data-token="([a-f0-9]+)"/.exec(page)[1];
    const send = type => fetch(`${url}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: JSON.stringify({ type, token }) });
    assert.equal((await (await send('history-status')).json()).running, true);
    await send('refresh');
    assert.equal(reads, 1);
    finish([]);
    for (let i = 0; i < 30; i++) {
      if (!(await (await send('history-status')).json()).running) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('sync did not finish');
  }, { t3DataDirectory: tmpdir() }, { readSource });
});

test('keeps the last successful snapshot when T3 is unavailable and recovers on retry', async () => {
  const original = submission({ source: 't3code', session: 'thread', messageId: 'first', submittedAt: new Date(), text: '最近一次成功提交' });
  const next = submission({ source: 't3code', session: 'thread', messageId: 'second', submittedAt: new Date(), text: '恢复后提交' });
  let read = 0;
  const readSource = async () => {
    if (++read === 2) throw new Error('raw SQLite error');
    return read === 1 ? [original] : [original, next];
  };
  await withServer(async (_directory, url) => {
    const page = await (await fetch(url)).text();
    const token = /<body data-token="([a-f0-9]+)"/.exec(page)[1];
    const send = type => fetch(`${url}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: JSON.stringify({ type, token }) });
    const waitForSnapshot = async () => {
      for (let i = 0; i < 30; i++) {
        if (!(await (await send('history-status')).json()).running) return (await fetch(url)).text();
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('sync did not finish');
    };
    assert.match(await waitForSnapshot(), /最近一次成功提交/);
    await send('refresh');
    const failed = await waitForSnapshot();
    assert.match(failed, /同步失败/);
    assert.match(failed, /最近一次成功提交/);
    assert.doesNotMatch(failed, /raw SQLite error/);
    await send('refresh');
    const recovered = await waitForSnapshot();
    assert.doesNotMatch(recovered, /同步失败/);
    assert.match(recovered, /恢复后提交/);
  }, { t3DataDirectory: tmpdir() }, { readSource });
});

test('all view clears selected calendar date and preserves other filters', async () => withServer(async (directory, url) => {
  const id = 'a'.repeat(64);
  await writeRecords(directory, [{ id, time: '2026-01-02T10:00:00', cwd: '/work/project', text: '匹配文本' }]);
  const page = await (await fetch(`${url}/?date=2026-01-02&month=2026-01&project=project&q=${encodeURIComponent('匹配')}`)).text();
  const nav = /<nav class="navigation"[^>]*>([\s\S]*?)<\/nav>/.exec(page)[1];
  const all = /<a class="nav-item active" href="([^"]*)">[\s\S]*?<span>全部<\/span><\/a>/.exec(nav);
  assert.ok(all);
  const target = new URL(all[1].replaceAll('&amp;', '&'), url);
  assert.equal(target.searchParams.has('date'), false);
  assert.equal(target.searchParams.get('month'), '2026-01');
  assert.equal(target.searchParams.get('project'), 'project');
  assert.equal(target.searchParams.get('q'), '匹配');
  const cleared = await (await fetch(target)).text();
  assert.doesNotMatch(cleared, /class="heat level-\d selected"/);
}));

test('orders collapsed and expanded projects by their latest matching record', async () => withServer(async (directory, url) => {
  const records = [
    ['2026-01-03T12:00:00', 'other', 'older-match'],
    ['2026-01-03T11:00:00', 'other', 'no-match'],
    ['2026-01-03T10:00:00', 'needle', 'newer-match'],
    ...Array.from({ length: 5 }, (_, i) => [`2026-01-03T09:0${i}:00`, 'needle', `project-${i}`]),
    ['2026-01-02T23:00:00', 'needle', 'older-match'],
  ].map(([time, text, project], i) => ({
    id: (i + 1).toString(16).repeat(64), time, text, cwd: `/work/${project}`, agent: 'codex',
  }));
  await writeRecords(directory, records);
  const projectNames = html => [...html.matchAll(/class="project-name">([^<]+)/g)].map(match => match[1]);
  const all = await (await fetch(url)).text();
  assert.deepEqual(projectNames(all).slice(0, 3), ['older-match', 'no-match', 'newer-match']);

  const filtered = await (await fetch(`${url}/?q=needle&sort=asc`)).text();
  const [initial, extra] = filtered.split('<details class="project-more">');
  assert.deepEqual(projectNames(initial), ['newer-match', 'project-4', 'project-3', 'project-2', 'project-1', 'project-0']);
  assert.deepEqual(projectNames(extra), ['older-match', 'no-match']);
}));

test('project facets follow other filters, retain selected zero counts, and distinguish paths', async () => withServer(async (directory, url) => {
  const records = [
    { id: '1'.repeat(64), time: '2026-01-02T10:00:00', text: 'needle', cwd: '/old/one/shared', agent: 'codex' },
    { id: '2'.repeat(64), time: '2026-01-01T10:00:00', text: 'other', cwd: '/old/two/shared', agent: 'codex' },
  ];
  await writeRecords(directory, records);
  const page = await (await fetch(`${url}/?q=needle&project=${encodeURIComponent('path:/old/two/shared')}`)).text();
  const group = page.split('id="project-filters"')[1].split('id="agent-filters"')[0];
  assert.match(group, /当前匹配项目数 \/ 全部历史项目数">1 \/ 2/);
  assert.match(group, /\/old\/one/);
  assert.match(group, /\/old\/two/);
  assert.match(group, /project-item local-filter active/);
  assert.match(group, /project-count">0</);
  assert.match(group, /project-count">1</);
  assert.match(page, /这里还没有记录/);
  const ambiguous = await (await fetch(`${url}/?project=shared`)).text();
  assert.equal((ambiguous.match(/project-item local-filter active/g) || []).length, 1);
  assert.match(ambiguous, /<p>0 条记录/);
}));

test('project and Agent counts use the same scope and can clear a zero-result selection', async () => withServer(async (directory, url) => {
  const today = '2026-01-02';
  const records = [
    { id: '1', time: `${today}T10:00:00`, text: 'alpha codex match', cwd: '/work/alpha', agent: 'codex' },
    { id: '2', time: '2026-01-01T10:00:00', text: 'alpha claude match', cwd: '/work/alpha', agent: 'claude' },
    { id: '3', time: `${today}T09:00:00`, text: 'beta claude match', cwd: '/work/beta', agent: 'claude' },
    { id: '4', time: `${today}T08:00:00`, text: 'alpha pi unrelated', cwd: '/work/alpha', agent: 'pi' },
  ];
  await writeRecords(directory, records);
  const params = new URLSearchParams({ date: today, q: 'match', project: 'path:/work/alpha', agent: 'claude' });
  const page = await (await fetch(`${url}/?${params}`)).text();
  assert.match(page, /<p>0 条记录/);
  assert.match(page, /当前匹配项目数 \/ 全部历史项目数">1 \/ 2/);
  assert.match(page, /当前匹配 Agent 数 \/ 全部历史 Agent 数">1 \/ 3/);
  assert.match(page, /<span>codex<\/span><span class="agent-count">1/);
  assert.match(page, /<span>claude<\/span><span class="agent-count">0/);
  const agentHref = /<a class="filter-item agent-item local-filter active"[^>]*href="([^"]+)"/.exec(page)[1];
  const clear = new URL(agentHref.replaceAll('&amp;', '&'), url);
  assert.equal(clear.searchParams.get('date'), today);
  assert.equal(clear.searchParams.get('project'), 'path:/work/alpha');
  assert.equal(clear.searchParams.get('q'), 'match');
  assert.equal(clear.searchParams.has('agent'), false);
  const cleared = await (await fetch(clear)).text();
  assert.match(cleared, /data-copy="alpha codex match"/);
  assert.doesNotMatch(cleared, /data-copy="(?:alpha claude|beta claude)/);
  assert.match(page, /aria-label="清除项目筛选"/);
  assert.match(page, /aria-label="清除 Agent 筛选"/);
}));

test('filters historical worktree URLs by their registered project and supports missing Agent identity', async () => withServer(async (directory, url) => {
  const projectRoot = '/registered/repo';
  await writeRecords(directory, [
    { id: '1', time: '2026-01-02T10:00:00', text: 'original checkout', cwd: projectRoot, projectRoot, agent: 'codex' },
    { id: '2', time: '2026-01-02T09:00:00', text: 'deleted worktree', cwd: '/worktrees/old', projectRoot, agent: null },
  ]);
  const page = await (await fetch(`${url}/?project=${encodeURIComponent('path:/worktrees/old')}`)).text();
  assert.match(page, /当前匹配项目数 \/ 全部历史项目数">1 \/ 1/);
  assert.match(page, /class="project-name">repo/);
  assert.match(page, /<p>2 条记录/);
  assert.match(page, /工作目录：\/worktrees\/old/);
  const unknown = await (await fetch(`${url}/?agent=unknown`)).text();
  assert.match(unknown, /data-copy="deleted worktree"/);
  assert.doesNotMatch(unknown, /data-copy="original checkout"/);
  const missing = await (await fetch(`${url}/?agent=missing&project=${encodeURIComponent('path:/old/project')}`)).text();
  assert.match(missing, /当前匹配项目数 \/ 全部历史项目数">0 \/ 1/);
  assert.match(missing, /当前匹配 Agent 数 \/ 全部历史 Agent 数">0 \/ 2/);
  assert.match(missing, /<span>missing<\/span><span class="agent-count">0/);
  assert.match(missing, /class="filter-item agent-item local-filter active" aria-current="true"/);
  assert.match(missing, /class="filter-item project-item local-filter active" aria-current="true"/);
}));
