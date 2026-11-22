import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { entryImages, isAutomaticPrompt, parseEntries, splitAttachments } from './diary.js';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { directoryFor } from './storage.js';
import { importHistory, readHistory } from './history-import.js';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function page(dates, selected, content, directory, nonce, error = '', history = null, running = false, syncError = '') {
  const links = dates.map((date) => `<a class="day${date === selected ? ' active' : ''}" href="/?date=${date}"${date === selected ? ' aria-current="page"' : ''}>${date}</a>`).join('');
  const imported = (history?.records || []).filter(record => localDate(record.time) === selected).map(record => ({ ...record, time: localTime(record.time), images: [], imported: true }));
  const local = parseEntries(content).filter(entry => !isAutomaticPrompt(entry.agent, entry.text) && !imported.some(record => entry.text.trim() === record.text.trim() && (!entry.cwd || !record.cwd || entry.cwd === record.cwd) && Math.abs(seconds(entry.time) - seconds(record.time)) <= 120));
  const entries = [...local, ...imported].sort((a, b) => a.time.localeCompare(b.time));
  const note = running ? '正在同步历史记录，页面会自动更新…' : syncError || (history ? `已读取 ${history.read}/${history.sessions} 个会话${history.truncated ? `，${history.truncated} 个会话被截断` : ''}${history.failed ? `，${history.failed} 个读取失败` : ''}${history.unsupported ? `，${history.unsupported} 个暂不支持` : ''}${history.unmatched ? `，${history.unmatched} 条未匹配到原始时间` : ''}` : '尚未同步历史记录');
  const cards = await Promise.all(entries.map(async (entry) => {
    const { images, displayedPaths } = await entryImages(entry, directory);
    const display = splitAttachments(entry.text, displayedPaths).display;
    const pictures = images.length ? `<div class="pictures">${images.map((src) => `<img src="${src}" alt="Prompt 附件" loading="lazy">`).join('')}</div>` : '';
    return `<article class="card"><div class="card-head"><time>${escapeHTML(selected)} ${escapeHTML(entry.time)}</time><button class="copy" type="button" data-copy="${escapeHTML(entry.text)}" aria-label="复制 Prompt">复制</button></div>${display ? `<div class="prompt">${escapeHTML(display)}</div>` : ''}${pictures}</article>`;
  }));
  const body = error ? `<div class="empty">${escapeHTML(error)}</div>`
    : selected && cards.length ? `<div class="cards">${cards.join('')}</div>`
      : selected && content.trim() ? `<article class="card"><div class="prompt">${escapeHTML(content)}</div></article>`
        : '<div class="empty"><strong>还没有记录</strong><p>通过 Magpie 使用 Agent 后，这里会按日期显示你的 Prompt。</p></div>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prompt 日记</title><style>
    :root{color-scheme:light dark;--bg:#f7f7f5;--panel:#fff;--fg:#252624;--muted:#92948e;--line:#ebebe7;--accent:#3a745e;--selected:#e8f1eb}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1280px;margin:auto;padding:38px 40px}header{margin-bottom:28px}h1{font-size:26px;letter-spacing:-.04em;margin:2px 0}header p{margin:0;color:var(--muted)}.eyebrow{color:var(--accent);font-size:11px;font-weight:700;letter-spacing:.12em}.layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:26px}.sidebar{border-top:1px solid var(--line);padding-top:16px}.sidebar h2{color:var(--muted);font-size:11px;letter-spacing:.08em;margin:0 0 12px}.day{display:block;padding:9px 12px;border-radius:8px;text-decoration:none;color:var(--fg);font-variant-numeric:tabular-nums}.day:hover,.day.active{background:var(--selected);color:var(--accent)}.day.active{font-weight:650}.cards{display:grid;gap:16px}.card,.empty{background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:0 2px 8px #00000008}.card{padding:22px 24px}.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.card-head time{font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}.copy{border:1px solid var(--line);background:transparent;color:var(--muted);padding:5px 11px;border-radius:7px;font:inherit;font-size:12px;cursor:pointer}.copy:hover{color:var(--accent);border-color:var(--accent)}.copy:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.prompt{font-size:15px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere}.pictures{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.pictures img{width:150px;height:150px;object-fit:cover;border-radius:10px;background:var(--bg)}.empty{padding:52px;text-align:center;color:var(--muted)}.empty strong{color:var(--fg);font-size:16px}.empty p{margin-bottom:0}@media(max-width:650px){.shell{padding:24px 18px}.layout{grid-template-columns:1fr;gap:16px}.sidebar{display:flex;gap:6px;overflow:auto;align-items:center}.sidebar h2{margin:0 10px 0 0;white-space:nowrap}.day{white-space:nowrap}.card{padding:18px}.pictures img{width:110px;height:110px}}@media(prefers-color-scheme:dark){:root{--bg:#171816;--panel:#20211f;--fg:#eeeeea;--muted:#9a9c94;--line:#343630;--accent:#9bd3b2;--selected:#293b30}}
    </style></head><body><main class="shell"><header><div class="eyebrow">YOUR DAILY RECORD</div><h1>Prompt 日记</h1><p>按日期回看经过 Magpie 的提问</p><p>${escapeHTML(note)} · <a href="/refresh">刷新历史</a></p></header><div class="layout"><nav class="sidebar" aria-label="选择日期"><h2>日期</h2>${links}</nav><section>${body}</section></div></main><script nonce="${nonce}">
    ${running ? 'setTimeout(() => location.reload(), 3000);' : ''}
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('.copy');
      if (!button) return;
      const text = button.dataset.copy;
      let copied = false;
      try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; } } catch {}
      if (!copied) {
        const field = document.createElement('textarea');
        field.value = text; field.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(field); field.focus(); field.select();
        try { copied = document.execCommand('copy'); } catch {}
        field.remove();
      }
      button.textContent = copied ? '已复制' : '复制失败';
      setTimeout(() => { button.textContent = '复制'; }, 2000);
    });
    </script></body></html>`;
}

function localDate(value) {
  const d = new Date(value), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function localTime(value) {
  const d = new Date(value), p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function seconds(value) { const [h,m,s] = value.split(':').map(Number); return h*3600+m*60+s; }

export function createDiaryServer(options = {}) {
  const directory = directoryFor(options);
  let syncing = false;
  return createServer(async (req, res) => {
    const nonce = randomBytes(16).toString('base64');
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; sandbox allow-scripts`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    };
    const send = (status, content) => { res.writeHead(status, headers); res.end(content); };
    // Reject DNS-rebinding hostnames. No CORS or API endpoints are exposed.
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) return send(403, 'Forbidden');
    if (req.method !== 'GET') return send(405, 'Method not allowed');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/refresh') {
      if (!syncing) {
        syncing = true;
        importHistory(options).catch(() => {}).finally(() => { syncing = false; });
      }
      res.writeHead(303, { ...headers, Location: '/' });
      return res.end();
    }
    if (url.pathname !== '/') return send(404, 'Not found');
    const requested = url.searchParams.get('date');
    if (requested !== null && !datePattern.test(requested)) return send(400, 'Invalid date');
    try {
      let files;
      try { files = await readdir(directory); } catch (err) { if (err.code !== 'ENOENT') throw err; files = []; }
      const history = await readHistory(directory);
      const dates = [...new Set([...files.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).map((name) => name.slice(0, -3)), ...(history?.records || []).map(record => localDate(record.time))])].sort().reverse();
      const running = syncing || files.includes('.history-import.lock');
      let syncError = ''; if (files.includes('.history-error')) syncError = await readFile(join(directory, '.history-error'), 'utf8');
      const selected = requested || dates[0] || '';
      if (requested && !dates.includes(requested)) return send(404, await page(dates, '', '', directory, nonce, '没有找到这一天的记录。'));
      let content = '';
      if (selected) {
        const path = join(directory, `${selected}.md`);
        if (files.includes(`${selected}.md`)) {
          if (!(await lstat(path)).isFile()) return send(404, await page(dates, '', '', directory, nonce, '无法读取这一天的记录。'));
          content = await readFile(path, 'utf8');
        }
      }
      return send(200, await page(dates, selected, content, directory, nonce, '', history, running, syncError));
    } catch {
      return send(500, await page([], '', '', directory, nonce, '读取记录失败，请检查日志目录的权限。'));
    }
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
