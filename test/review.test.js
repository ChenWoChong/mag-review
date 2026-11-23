import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDiaryServer } from '../server.js';
import { reviewInput, parseReview, generateReview, readReview, saveReview } from '../review.js';
import { hashText } from '../identity.js';

const empty = { entries: {}, pinned: [], templates: {}, feedback: {} };
const record = (id, day, session, text = '测试内容') => ({ id: id.repeat(64), day, time: '12:00:00', project: 'project', agent: 'codex', session, text, aliases: [], images: [] });

test('review input excludes hidden records and limits rather than discards source data', () => {
  const a = record('a', '2026-11-21', 'session-a', 'a'.repeat(7000));
  const b = record('b', '2026-11-22', 'session-b');
  const input = reviewInput([b, a], empty, 'weekly', '2026-11-22');
  assert.equal(input.entries.length, 2);
  assert.equal(input.entries[0].text.length, 6000);
  assert.equal(input.truncated, 1);
  assert.equal(a.text.length, 7000);
  const hidden = reviewInput([a, b], { ...empty, entries: { [b.id]: { hidden: true, tags: [] } } }, 'weekly', '2026-11-22');
  assert.equal(hidden.entries.length, 1);
  assert.throws(() => reviewInput([a], empty, 'daily', '2026-02-31'));
});

test('review citations must exist and weekly patterns span dates and sessions', () => {
  const records = [record('a', '2026-11-21', 'one'), record('b', '2026-11-22', 'one'), record('c', '2026-11-22', 'two')];
  const input = reviewInput(records, empty, 'weekly', '2026-11-22');
  const body = { issues: [], templates: [], corrections: [
    { title: '同一会话', detail: '过滤', sources: ['p2', 'p3'] },
    { title: '有证据', detail: '保留', sources: ['p1', 'p3', 'invented'] },
    { title: '无证据', detail: '过滤', sources: ['invented'] },
  ] };
  const result = parseReview(JSON.stringify(body), input);
  assert.equal(result.corrections.length, 1);
  assert.equal(result.corrections[0].title, '有证据');
  assert.equal(result.corrections[0].sources.length, 2);
  assert.equal(parseReview(JSON.stringify({ corrections: [body.corrections[1]] }), input).corrections.length, 1);
  assert.throws(() => parseReview('not json', input));
});

test('generation uses only authorized input, persists evidence and retains old output on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'review-test-'));
  try {
    const entries = [record('a', '2026-11-22', 's', '真正的用户输入')];
    let request;
    const report = await generateReview({ records: entries, data: empty, kind: 'daily', day: '2026-11-22', model: 'test/model', gateway: 'http://127.0.0.1:1', fetcher: async (_url, init) => {
      request = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ issues: [{ title: '问题', detail: '内容', sources: ['p1'] }], corrections: [], templates: [] }) } }] }) };
    } });
    assert.equal(request.user, 'magpie-prompt-diary-review');
    assert.equal(report.sections.issues[0].sources[0], entries[0].id);
    await saveReview(directory, report);
    assert.equal((await readReview(directory, '2026-11-22', 'daily')).sections.issues[0].title, '问题');
    assert.match(await readFile(join(directory, 'reviews/2026-11-22-daily.md'), 'utf8'), /来源记录/);
    await assert.rejects(generateReview({ records: entries, data: empty, kind: 'daily', day: '2026-11-22', model: 'test', gateway: 'http://127.0.0.1:1', fetcher: async () => ({ ok: false, status: 500 }) }));
    assert.ok(await readReview(directory, '2026-11-22', 'daily'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('review endpoint generates, renders evidence and saves original template with feedback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'review-server-'));
  const id = 'a'.repeat(64), day = '2026-11-22';
  await writeFile(join(directory, '.history.json'), JSON.stringify({ version: 1, sessions: 1, read: 1, records: [{ id, time: new Date(2026, 10, 22, 12).toISOString(), text: '原始模板内容', cwd: '/tmp/project', agent: 'codex', session: 'one' }] }));
  const gatewayInfo = async () => ({ origin: 'http://127.0.0.1:1', models: ['test/model'], selected: 'test/model' });
  const generate = async ({ records, kind }) => ({ version: 1, kind, day, from: day, model: 'test/model', generatedAt: new Date().toISOString(), total: 1, included: 1, truncated: 0, sections: { issues: [{ id: 'b'.repeat(64), title: '问题', detail: '分析', sources: [records[0].id] }], corrections: [], templates: [{ id: 'c'.repeat(64), title: '模板', detail: '推荐', sources: [records[0].id] }] } });
  const server = createDiaryServer({ directory }, { gatewayInfo, generateReview: generate });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${url}/?view=review&reviewDate=${day}`)).text();
    const token = /<body data-token="([a-f0-9]+)"/.exec(page)[1];
    const send = payload => fetch(`${url}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: JSON.stringify({ ...payload, token }) });
    assert.match(page, /复盘与沉淀/);
    assert.equal((await send({ type: 'review-start', model: 'test/model', kind: 'daily', day })).status, 200);
    for (let i = 0; i < 20; i++) {
      if ((await (await send({ type: 'review-status' })).json()).state === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const result = await (await fetch(`${url}/?view=review&reviewDate=${day}`)).text();
    assert.match(result, /查看原始 Prompt（1）/);
    assert.match(result, /原始模板内容/);
    assert.equal((await send({ type: 'review-feedback', day, kind: 'daily', id: 'c'.repeat(64), value: 'saved' })).status, 200);
    const saved = JSON.parse(await readFile(join(directory, '.annotations.json'), 'utf8'));
    assert.equal(saved.feedback['c'.repeat(64)], 'saved');
    assert.equal(saved.templates[hashText('review-template:' + 'c'.repeat(64))].text, '原始模板内容');
    assert.equal(saved.entries[id].favorite, true);
    assert.equal((await send({ type: 'review-feedback', day, kind: 'daily', id: 'd'.repeat(64), value: 'saved' })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});
