import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { directoryFor } from './storage.js';
import { importHistory } from './history-import.js';
import { readAnnotations, updateAnnotations } from './annotations.js';
import { loadRecords } from './records.js';
import { renderPage } from './views.js';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function createDiaryServer(options = {}) {
  const directory = directoryFor(options);
  const token = randomBytes(32).toString('hex');
  let syncing = false;
  return createServer(async (req, res) => {
    const nonce = randomBytes(16).toString('base64');
    const host = req.headers.host || '';
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; connect-src http://${host}; sandbox allow-scripts`,
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    };
    const send = (status, content) => { res.writeHead(status, headers); res.end(content); };
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(host)) return send(403, 'Forbidden');
    let url = new URL(req.url, 'http://127.0.0.1');
    let filteredRequest = false;
    if (url.pathname === '/action' || url.pathname === '/filter') {
      const filtering = url.pathname === '/filter';
      if (req.method !== 'POST') return send(405, 'Method not allowed');
      // The page is in Magpie's sandboxed iframe, whose origin is null. A
      // per-process token keeps unrelated sites from changing local markers.
      const cors = { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' };
      if (req.headers.origin !== 'null') { res.writeHead(403, cors); return res.end('Forbidden'); }
      try {
        let bytes = 0, body = '';
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { res.writeHead(413, cors); return res.end('Too large'); }
          body += chunk.toString('utf8');
        }
        const action = JSON.parse(body);
        const supplied = Buffer.from(typeof action.token === 'string' ? action.token : '');
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403, cors); return res.end('Forbidden'); }
        if (filtering) {
          if (typeof action.path !== 'string' || !action.path.startsWith('/?') && action.path !== '/') { res.writeHead(400, cors); return res.end('Invalid path'); }
          filteredRequest = true;
          url = new URL(action.path, 'http://127.0.0.1');
          if (url.pathname !== '/' || url.origin !== 'http://127.0.0.1') { res.writeHead(400, cors); return res.end('Invalid path'); }
        } else if (action.type === 'refresh') {
          if (!syncing) {
            syncing = true;
            importHistory(options).catch(() => {}).finally(() => { syncing = false; });
          }
        } else await updateAnnotations(directory, action);
        if (!filtering) { res.writeHead(200, cors); return res.end('ok'); }
        headers['Access-Control-Allow-Origin'] = 'null';
        headers.Vary = 'Origin';
      } catch { res.writeHead(400, cors); return res.end('Invalid action'); }
    }
    if (req.method !== 'GET' && !filteredRequest) return send(405, 'Method not allowed');
    if (url.pathname !== '/') return send(404, 'Not found');
    const date = url.searchParams.get('date');
    if (date !== null && !datePattern.test(date)) return send(400, 'Invalid date');
    try {
      const { records, history, files } = await loadRecords(directory);
      const annotations = await readAnnotations(directory);
      const dates = new Set([...records.map(r => r.day), ...files.filter(n => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map(n => n.slice(0, -3))]);
      let fallback = '';
      if (!records.length && dates.size && (!date || dates.has(date))) {
        const day = date || [...dates].sort().at(-1);
        fallback = await readFile(join(directory, `${day}.md`), 'utf8');
      }
      let syncError = '';
      if (files.includes('.history-error')) syncError = await readFile(join(directory, '.history-error'), 'utf8');
      return send(200, await renderPage({ records, history, data: annotations, directory, params: url.searchParams, nonce, token, running: syncing || files.includes('.history-import.lock'), syncError, fallback }));
    } catch { return send(500, '读取记录失败，请检查日志目录的权限。'); }
  });
}

export async function startServer(options = {}) {
  const port = Number(options.port ?? 3479);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Prompt Diary port must be between 1024 and 65535');
  const server = createDiaryServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
