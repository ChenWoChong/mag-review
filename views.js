import { entryImages, splitAttachments } from './diary.js';
import { annotate, localDate } from './records.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => localDate(new Date());
function before(days) { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - days); return localDate(d); }
function rangeStart(range) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  if (range === 'today') return localDate(d);
  if (range === 'this-week') d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  else if (range === 'last-7') d.setDate(d.getDate() - 6);
  else if (range === 'month') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  } else return '';
  return localDate(d);
}
function url(params, changes) {
  const q = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) value ? q.set(key, value) : q.delete(key);
  const s = q.toString();
  return `/${s ? `?${esc(s)}` : ''}`;
}
function filtered(records, data, params) {
  const view = params.get('view') || 'all';
  const start = rangeStart(params.get('range'));
  const query = (params.get('q') || '').trim().toLocaleLowerCase();
  return records.filter(record => {
    const mark = annotate(record, data);
    if (view === 'hidden' ? !mark.hidden : mark.hidden) return false;
    if ((view === 'today' || view === 'review') && record.day !== today()) return false;
    if (view === 'week' && record.day < before(6)) return false;
    if (start && (record.day < start || record.day > today())) return false;
    if (query && !record.text.toLocaleLowerCase().includes(query)) return false;
    if (view === 'images' && !record.hasImage) return false;
    if (view === 'favorites' && !mark.favorite) return false;
    if (params.get('date') && record.day !== params.get('date')) return false;
    if (params.get('agent') && record.agent !== params.get('agent')) return false;
    if (params.get('project') && record.project !== params.get('project')) return false;
    if (params.get('tag') && !mark.tags.includes(params.get('tag'))) return false;
    return true;
  });
}

function heatmap(records, params) {
  const requested = params.get('month') || (params.get('date') || '').slice(0, 7);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : today().slice(0, 7);
  const [year, index] = month.split('-').map(Number);
  const first = new Date(year, index - 1, 1, 12);
  const total = new Date(year, index, 0, 12).getDate();
  const monthOf = offset => { const d = new Date(year, index - 1 + offset, 1, 12); return localDate(d).slice(0, 7); };
  const count = new Map();
  for (const record of records) if (record.day.startsWith(month + '-')) count.set(record.day, (count.get(record.day) || 0) + 1);
  const max = Math.max(1, ...count.values());
  let cells = '<span class="calendar-spacer"></span>'.repeat((first.getDay() + 6) % 7);
  for (let day = 1; day <= total; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`, n = count.get(date) || 0;
    const level = n ? Math.min(4, Math.max(1, Math.ceil(n / max * 4))) : 0;
    cells += `<a class="heat level-${level}${params.get('date') === date ? ' selected' : ''}" href="${url(params, { date, month, range: '', page: '' })}" title="${date} · ${n} 条已收录" aria-label="${date}，${n} 条已收录">${day}</a>`;
  }
  const weekdays = ['一','二','三','四','五','六','日'].map(day => `<span>${day}</span>`).join('');
  return `<div class="heat-head" id="calendar"><span>活动记录</span><div class="month-nav"><a href="${url(params, { month: monthOf(-1), date: '', page: '' })}" aria-label="上个月">‹</a><strong>${year} 年 ${index} 月</strong><a href="${url(params, { month: monthOf(1), date: '', page: '' })}" aria-label="下个月">›</a></div></div><div class="weekdays">${weekdays}</div><div class="heatmap">${cells}</div>`;
}

// Convert T3's image references for display only; the stored and copied text stays intact.
function renderPrompt(text) {
  const badge = name => `<span class="attachment-label" aria-label="图片附件：${esc(name)}"><span aria-hidden="true">▧</span> ${esc(name)}</span>`;
  const fence = /(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*(?=\n|$))/gm;
  const renderChunk = chunk => {
    const blockPattern = /^[ \t]*<t3_context version="1">\s*([\s\S]*?)\s*<\/t3_context>[ \t]*(?:\n|$)/gm;
    const blocks = new Map();
    for (const match of chunk.matchAll(blockPattern)) {
      const contexts = [...match[1].matchAll(/<context kind="image" id="([\w-]+)">\s*([\s\S]*?)\s*<\/context>/g)];
      if (!contexts.length || match[1].replace(/<context kind="image" id="[\w-]+">\s*[\s\S]*?\s*<\/context>/g, '').trim()) continue;
      const items = [];
      for (const context of contexts) {
        const fields = context[2].split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!fields.every(line => /^(?:name|mimeType|sizeBytes|attachmentId): [^\n]+$/.test(line))) break;
        const name = fields.find(line => line.startsWith('name: '))?.slice(6);
        const mime = fields.find(line => line.startsWith('mimeType: '))?.slice(10);
        if (!name || !mime?.startsWith('image/') || !fields.some(line => line.startsWith('attachmentId: '))) break;
        items.push({ id: context[1], name });
      }
      if (items.length === contexts.length) blocks.set(match.index, { length: match[0].length, items });
    }
    const marker = /\[Image: ([^\]\n]*?); ref=([\w-]+)\]/g;
    const references = new Set([...chunk.matchAll(marker)].map(match => match[2]));
    const tokens = [];
    for (const match of chunk.matchAll(marker)) tokens.push({ start: match.index, end: match.index + match[0].length, html: badge(match[1]) });
    for (const [start, block] of blocks) tokens.push({ start, end: start + block.length, html: block.items.filter(item => !references.has(item.id)).map(item => badge(item.name)).join(' ') });
    tokens.sort((a, b) => a.start - b.start || b.end - a.end);
    let result = '', pos = 0;
    for (const token of tokens) {
      if (token.start < pos) continue;
      result += esc(chunk.slice(pos, token.start)) + token.html;
      pos = token.end;
    }
    return result + esc(chunk.slice(pos));
  };
  let result = '', pos = 0;
  for (const match of text.matchAll(fence)) {
    result += renderChunk(text.slice(pos, match.index)) + esc(match[0]);
    pos = match.index + match[0].length;
  }
  return result + renderChunk(text.slice(pos));
}

async function card(entry, data, directory) {
  const mark = annotate(entry, data), ids = esc([entry.id, ...entry.aliases].join(','));
  const { images, displayedPaths } = await entryImages(entry, directory);
  const display = splitAttachments(entry.text, displayedPaths).display;
  const pictures = images.length ? `<div class="pictures">${images.map(src => `<button type="button" class="image-preview" aria-label="放大查看图片"><img src="${src}" alt="Prompt 附件" loading="lazy"></button>`).join('')}</div>` : '';
  const tags = mark.tags.map(tag => `<span class="tag">${esc(tag)} <button type="button" class="untag" data-ids="${ids}" data-tag="${esc(tag)}" aria-label="移除标签 ${esc(tag)}">×</button></span>`).join('');
  return `<article class="card"><div class="card-head"><time>${entry.day} ${esc(entry.time)}</time><div class="actions"><button class="favorite action" type="button" data-ids="${ids}" data-value="${!mark.favorite}" aria-label="${mark.favorite ? '取消收藏' : '收藏'}" title="${mark.favorite ? '取消收藏' : '收藏'}">${mark.favorite ? '★' : '☆'}</button><button class="copy action" type="button" data-copy="${esc(entry.text)}">复制</button><details class="more"><summary aria-label="更多操作">···</summary><div class="menu"><button type="button" class="add-tag" data-ids="${ids}">添加标签</button><button type="button" class="edit-template" data-id="${esc(entry.id)}">保存为模板</button><button type="button" class="hide-record" data-ids="${ids}" data-value="${!mark.hidden}">${mark.hidden ? '恢复显示' : '隐藏此条'}</button></div></details></div></div>${display ? `<div class="prompt">${renderPrompt(display)}</div>` : ''}${pictures}<details class="source"><summary>来源：${esc(entry.source)} · 查看原文和来源</summary><div>工作目录：${esc(entry.cwd || '未知')}</div>${entry.session ? `<div>会话：${esc(entry.session)}</div>` : ''}<pre>${esc(entry.text)}</pre></details><div class="tag-editor" hidden><input type="text" maxlength="32" placeholder="输入标签名称" aria-label="标签名称"><button type="button" class="save-tag" data-ids="${ids}">保存</button><button type="button" class="cancel-tag">取消</button></div>${templateEditor(entry.id)}<div class="card-tags"><span class="tag">${esc(entry.agent || '未知 Agent')}</span><span class="tag" title="${esc(entry.cwd || '未知项目')}">${esc(entry.project)}</span>${tags}</div></article>`;
}

function templateEditor(id) {
  return `<div class="template-editor" hidden><input maxlength="80" placeholder="模板名称" aria-label="模板名称"><textarea maxlength="200000" rows="8" placeholder="编辑模板内容" aria-label="模板内容"></textarea><p>可以把项目名等内容替换为占位符，例如 {项目名}。</p><button type="button" class="save-template" data-id="${esc(id)}">保存模板</button><button type="button" class="cancel-template">取消</button></div>`;
}

function templateCard(id, template) {
  return `<article class="card"><div class="card-head"><strong>${esc(template.title)}</strong><div class="actions"><button class="copy action" type="button" data-copy="${esc(template.text)}">复制</button><button class="edit-template action" type="button" data-id="${esc(id)}" data-title="${esc(template.title)}">编辑</button><button class="delete-template action" type="button" data-id="${esc(id)}">删除模板</button></div></div><div class="prompt">${esc(template.text)}</div>${templateEditor(id)}</article>`;
}

export async function renderPage({ records, history, data, directory, params, nonce, token, running, syncError, fallback }) {
  const visible = records.filter(record => !annotate(record, data).hidden);
  const view = params.get('view') || 'all';
  const nav = [['all','全部 Prompt'],['images','有图片'],['favorites','已收藏']];
  const ranges = [['','全部'],['today','当天'],['this-week','本周'],['last-7','近 7 天'],['month','近一个月']];
  const range = ranges.find(([id]) => id === (params.get('range') || '')) || ranges[0];
  const rangeMenu = ranges.map(([id, label]) => `<a class="range-option${range[0] === id ? ' active' : ''}" href="${url(params, { range: id, date: '', page: '' })}"${range[0] === id ? ' aria-current="true"' : ''}>${label}</a>`).join('');
  const navHTML = nav.map(([id, title]) => `<a class="nav-item${view === id ? ' active' : ''}" href="${url(params, { view: id === 'all' ? '' : id, page: '' })}">${title}</a>`).join('');
  const unique = key => [...new Set(visible.map(r => r[key]).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'zh-CN'));
  const groups = (label, key) => {
    const vals = unique(key), current = params.get(key);
    const links = vals.map(value => `<a class="filter-item${current === value ? ' active' : ''}" title="${esc(value)}" href="${url(params, { [key]: current === value ? '' : value, date: '', page: '' })}">${esc(value)}</a>`).join('');
    return `<details class="group" id="${key}-filters"${current ? ' open' : ''}><summary>${label} <span>${vals.length}</span></summary>${links || '<span class="hint">暂无记录</span>'}</details>`;
  };
  const tags = [...new Set(visible.flatMap(r => annotate(r, data).tags))].sort((a,b) => a.localeCompare(b, 'zh-CN'));
  const tagLinks = tags.sort((a,b) => Number(data.pinned.includes(b)) - Number(data.pinned.includes(a))).map(tag => `<div class="tag-row"><a class="filter-item${params.get('tag') === tag ? ' active' : ''}" href="${url(params, { tag: params.get('tag') === tag ? '' : tag, date: '', page: '' })}"># ${esc(tag)}</a><button class="pin-tag" data-tag="${esc(tag)}" data-value="${!data.pinned.includes(tag)}" title="${data.pinned.includes(tag) ? '取消置顶' : '置顶标签'}">${data.pinned.includes(tag) ? '★' : '☆'}</button></div>`).join('');
  let list = view === 'templates' ? [] : filtered(records, data, params);
  if (params.get('sort') === 'asc') list.reverse();
  if (view === 'random' && list.length) list = [list[Math.floor(Math.random() * list.length)]];
  const templates = view === 'templates' ? Object.entries(data.templates || {}) : [];
  const total = view === 'templates' ? templates.length : list.length, pages = Math.max(1, Math.ceil(total / 30));
  const page = Math.min(pages, Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1));
  const items = view === 'templates'
    ? templates.slice((page - 1) * 30, page * 30).map(([id, template]) => templateCard(id, template))
    : await Promise.all(list.slice((page - 1) * 30, page * 30).map(r => card(r, data, directory)));
  const text = items.length ? `<div class="cards">${items.join('')}</div>` : fallback ? `<article class="card"><div class="prompt">${esc(fallback)}</div></article>` : `<div class="empty"><strong>这里还没有记录</strong><p>试试其他日期或筛选条件。</p></div>`;
  const pager = pages > 1 ? `<div class="pager">${page > 1 ? `<a href="${url(params,{page:String(page-1)})}">上一页</a>` : ''}<span>${page} / ${pages}</span>${page < pages ? `<a href="${url(params,{page:String(page+1)})}">下一页</a>` : ''}</div>` : '';
  const filterLabels = [params.get('date'), params.get('agent'), params.get('project'), params.get('tag') && `#${params.get('tag')}`].filter(Boolean).map(x => `<span class="filter-chip">${esc(x)}</span>`).join('');
  const dateCount = new Set(visible.map(r => r.day)).size;
  const breakdown = key => {
    const counts = new Map();
    for (const r of list) counts.set(r[key] || '未知', (counts.get(r[key] || '未知') || 0) + 1);
    return [...counts].map(([name, count]) => `<span>${esc(name)} · ${count}</span>`).join('') || '<span>暂无记录</span>';
  };
  const review = view === 'review' ? `<div class="review-summary"><div><strong>今天的项目</strong><div class="meta">${breakdown('project')}</div></div><div><strong>使用的 Agent</strong><div class="meta">${breakdown('agent')}</div></div></div>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prompt 日记</title><style>${styles}</style></head><body data-token="${esc(token)}"><main class="shell"><aside class="sidebar"><div class="brand"><div class="eyebrow">PROMPT DIARY</div></div><div class="stats"><a href="/" class="stat"><strong>${visible.length}</strong><span>已收录</span></a><a href="#calendar" class="stat"><strong>${dateCount}</strong><span>记录天数</span></a><a href="#project-filters" class="stat project-shortcut"><strong>${unique('project').filter(x => x !== '未知项目').length}</strong><span>项目</span></a></div>${heatmap(visible, params)}<nav class="navigation" aria-label="记录视图">${navHTML}</nav>${groups('项目','project')}${groups('Agent','agent')}<details class="group"${params.get('tag') ? ' open' : ''}><summary>标签 <span>${tags.length}</span></summary>${tagLinks || '<span class="hint">在卡片上添加标签</span>'}</details></aside><section class="main"><header class="main-head"><div><div class="heading-row"><details class="range-menu"><summary aria-label="选择时间范围">${range[1]} <span aria-hidden="true">⌄</span></summary><div class="range-options">${rangeMenu}</div></details><a class="sort-order local-filter" href="${url(params, { sort: params.get('sort') === 'asc' ? '' : 'asc', page: '' })}" aria-label="${params.get('sort') === 'asc' ? '当前时间正序，点击切换为倒序' : '当前时间倒序，点击切换为正序'}" title="${params.get('sort') === 'asc' ? '时间正序：最早在前' : '时间倒序：最新在前'}"><span aria-hidden="true">${params.get('sort') === 'asc' ? '↑' : '↓'}</span></a></div><p>${total} 条记录 ${filterLabels}</p></div><form class="search-form" role="search"><input type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="搜索 Prompt" aria-label="搜索 Prompt" autocomplete="off"><button type="submit" aria-label="搜索">⌕</button></form></header>${review}${text}${pager}</section></main><dialog class="image-dialog" aria-label="图片预览"><button type="button" class="close-preview" aria-label="关闭图片预览">×</button><button type="button" class="preview-prev" aria-label="上一张图片">‹</button><img alt="放大的 Prompt 附件"><button type="button" class="preview-next" aria-label="下一张图片">›</button><div class="preview-count" aria-live="polite"></div></dialog><script nonce="${nonce}">${client}${running ? '\nsetTimeout(() => location.reload(), 3000);' : ''}</script></body></html>`;
}

const client = `
// The local page replaces the original bridge page in Magpie's frame.
// Ask the same parent for its current theme and listen for later changes.
function applyMagpieTheme(theme) {
  if (!theme || typeof theme.dark !== 'boolean') return;
  const root = document.documentElement;
  root.dataset.theme = theme.dark ? 'dark' : 'light';
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
  for (const name of ['bg', 'card', 'fg', 'muted', 'line', 'accent', 'accent-soft']) {
    const value = theme.tokens?.[name];
    if (typeof value === 'string' && value.trim()) root.style.setProperty('--magpie-' + name, value);
    else root.style.removeProperty('--magpie-' + name);
  }
}
if (window.parent !== window) {
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.magpie !== 1) return;
    if (event.data.event === 'theme') applyMagpieTheme(event.data.data);
    else if (event.data.id === 'prompt-diary-theme') applyMagpieTheme(event.data.result);
  });
  window.parent.postMessage({ magpie: 1, id: 'prompt-diary-theme', method: 'theme' }, '*');
}
let previewImages = [], previewIndex = 0, touchStart = null, lastSwipe = 0, wheelDelta = 0, lastWheel = 0;
function showPreview(index) {
  if (index < 0 || index >= previewImages.length) return;
  previewIndex = index;
  const dialog = document.querySelector('.image-dialog');
  dialog.querySelector('img').src = previewImages[index];
  const previous = dialog.querySelector('.preview-prev'), next = dialog.querySelector('.preview-next');
  previous.hidden = next.hidden = previewImages.length < 2;
  previous.disabled = index === 0;
  next.disabled = index === previewImages.length - 1;
  const count = dialog.querySelector('.preview-count');
  count.hidden = previewImages.length < 2;
  count.textContent = (index + 1) + ' / ' + previewImages.length;
}
document.addEventListener('touchstart', event => {
  if (event.target.closest('.image-dialog') && event.touches.length === 1) touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });
document.addEventListener('touchend', event => {
  if (!touchStart || !event.target.closest('.image-dialog') || !event.changedTouches.length) { touchStart = null; return; }
  const dx = event.changedTouches[0].clientX - touchStart.x, dy = event.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) showPreview(previewIndex + (dx < 0 ? 1 : -1));
}, { passive: true });
document.addEventListener('wheel', event => {
  const dialog = document.querySelector('.image-dialog');
  if (!dialog?.open || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  const now = Date.now();
  if (now - lastWheel > 200) wheelDelta = 0;
  lastWheel = now;
  if (now - lastSwipe < 400) return;
  wheelDelta += event.deltaX;
  if (Math.abs(wheelDelta) < 50) return;
  lastSwipe = now;
  showPreview(previewIndex + (wheelDelta > 0 ? 1 : -1));
  wheelDelta = 0;
}, { passive: true });
let filterSequence = 0;
let currentPath = location.pathname + location.search;
let searchTimer;
async function selectRange(path, addHistory = true, replaceHistory = false) {
  const sequence = ++filterSequence;
  const menu = document.querySelector('.range-menu');
  menu.open = false;
  const response = await fetch('/filter', { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({ path, token:document.body.dataset.token }) });
  if (!response.ok) throw new Error('筛选失败');
  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  if (sequence !== filterSequence) return;
  const oldSidebar = document.querySelector('.sidebar'), nextSidebar = page.querySelector('.sidebar');
  const oldMain = document.querySelector('.main'), nextMain = page.querySelector('.main');
  if (!oldSidebar || !nextSidebar || !oldMain || !nextMain) throw new Error('筛选失败');
  const scroll = oldSidebar.scrollTop;
  const opened = [...oldSidebar.querySelectorAll('details.group')].map(group => group.open);
  nextSidebar.querySelectorAll('details.group').forEach((group, i) => { group.open = opened[i]; });
  oldSidebar.replaceWith(nextSidebar);
  nextSidebar.scrollTop = scroll;
  const search = oldMain.querySelector('.search-form input');
  const focused = search && document.activeElement === search;
  const caret = focused ? search.selectionStart : null;
  oldMain.replaceWith(nextMain);
  if (focused) {
    const nextSearch = nextMain.querySelector('.search-form input');
    nextSearch.focus({ preventScroll: true });
    if (caret !== null) try { nextSearch.setSelectionRange(caret, caret); } catch {}
  }
  currentPath = path;
  if (addHistory) { try { history[replaceHistory ? 'replaceState' : 'pushState'](null, '', path); } catch {} }
}
window.addEventListener('popstate', () => { selectRange(location.pathname + location.search, false).catch(() => location.reload()); });
async function update(action) {
  const response = await fetch('/action', { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({ ...action, token:document.body.dataset.token }) });
  if (!response.ok) throw new Error('保存失败');
  location.assign(currentPath);
}
document.addEventListener('click', async event => {
  const dialog = document.querySelector('.image-dialog');
  if (dialog && event.target === dialog) { dialog.close(); return; }
  const menu = document.querySelector('.range-menu');
  if (menu && !menu.contains(event.target)) menu.open = false;
  const option = event.target.closest('.range-option, .local-filter');
  if (option && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
    event.preventDefault();
    clearTimeout(searchTimer);
    const next = new URL(option.href);
    const search = document.querySelector('.search-form input');
    if (search) { if (search.value.trim()) next.searchParams.set('q', search.value.trim()); else next.searchParams.delete('q'); }
    const path = next.pathname + next.search;
    selectRange(path).catch(() => { location.assign(path); });
    return;
  }
  if (event.target.closest('.project-shortcut')) document.getElementById('project-filters').open = true;
  const target = event.target.closest('button'); if (!target) return;
  const ids = (target.dataset.ids || '').split(',').filter(Boolean);
  try {
    if (target.classList.contains('image-preview')) {
      const buttons = [...target.closest('.pictures').querySelectorAll('.image-preview')];
      previewImages = buttons.map(button => button.querySelector('img').src);
      showPreview(buttons.indexOf(target));
      dialog.showModal();
    } else if (target.classList.contains('preview-prev')) showPreview(previewIndex - 1);
    else if (target.classList.contains('preview-next')) showPreview(previewIndex + 1);
    else if (target.classList.contains('close-preview')) dialog.close();
    else if (target.classList.contains('copy')) {
      let copied = false; try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(target.dataset.copy); copied = true; } } catch {}
      if (!copied) { const field = document.createElement('textarea'); field.value = target.dataset.copy; field.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(field); field.focus(); field.select(); try { copied = document.execCommand('copy'); } catch {} field.remove(); }
      target.textContent = copied ? '已复制' : '复制失败'; setTimeout(() => { target.textContent = '复制'; }, 2000);
    } else if (target.classList.contains('favorite')) await update({type:'favorite',ids,value:target.dataset.value === 'true'});
    else if (target.classList.contains('hide-record')) await update({type:'hidden',ids,value:target.dataset.value === 'true'});
    else if (target.classList.contains('untag')) await update({type:'tag',ids,tag:target.dataset.tag,value:false});
    else if (target.classList.contains('pin-tag')) await update({type:'pin',tag:target.dataset.tag,value:target.dataset.value === 'true'});
    else if (target.classList.contains('add-tag')) { const c=target.closest('.card'); c.querySelector('.tag-editor').hidden=false; c.querySelector('details').open=false; c.querySelector('input').focus(); }
    else if (target.classList.contains('cancel-tag')) target.closest('.tag-editor').hidden=true;
    else if (target.classList.contains('save-tag')) { const tag=target.closest('.tag-editor').querySelector('input').value.trim(); if (tag) await update({type:'tag',ids,tag,value:true}); }
    else if (target.classList.contains('edit-template')) {
      const card = target.closest('.card'), editor = card.querySelector('.template-editor');
      editor.hidden = false; editor.querySelector('input').value = target.dataset.title || '';
      editor.querySelector('textarea').value = card.querySelector('.copy').dataset.copy;
      if (target.closest('details')) target.closest('details').open = false;
      editor.querySelector('input').focus();
    }
    else if (target.classList.contains('cancel-template')) target.closest('.template-editor').hidden=true;
    else if (target.classList.contains('save-template')) {
      const editor = target.closest('.template-editor'), title = editor.querySelector('input').value.trim(), text = editor.querySelector('textarea').value;
      if (title && text.trim()) await update({type:'template-save',id:target.dataset.id,title,text});
    }
    else if (target.classList.contains('delete-template')) await update({type:'template-delete',id:target.dataset.id});
  } catch { target.textContent='保存失败'; }
});
function searchFor(value) {
  const next = new URL(currentPath, location.href);
  if (value.trim()) next.searchParams.set('q', value.trim()); else next.searchParams.delete('q');
  next.searchParams.delete('page');
  const path = next.pathname + next.search;
  selectRange(path, true, true).catch(() => { location.assign(path); });
}
document.addEventListener('input', event => {
  if (!event.target.matches('.search-form input') || event.isComposing) return;
  ++filterSequence;
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => searchFor(value), 250);
});
document.addEventListener('compositionstart', event => {
  if (event.target.matches('.search-form input')) { ++filterSequence; clearTimeout(searchTimer); }
});
document.addEventListener('compositionend', event => {
  if (!event.target.matches('.search-form input')) return;
  ++filterSequence;
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => searchFor(value), 250);
});
document.addEventListener('submit', event => {
  if (!event.target.matches('.search-form')) return;
  event.preventDefault();
  clearTimeout(searchTimer);
  searchFor(event.target.querySelector('input').value);
});
document.addEventListener('keydown', event => { if (document.querySelector('.image-dialog')?.open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); showPreview(previewIndex + (event.key === 'ArrowLeft' ? -1 : 1)); return; } if (event.key === 'Escape') { const menu = document.querySelector('.range-menu'); if (menu?.open) { menu.open = false; menu.querySelector('summary').focus(); } } if (event.key === 'Enter' && event.target.matches('.tag-editor input')) { event.preventDefault(); event.target.parentElement.querySelector('.save-tag').click(); } });
`;

const styles = `
:root{color-scheme:light dark;--bg:var(--magpie-bg,#f6f7f5);--panel:var(--magpie-card,#fff);--fg:var(--magpie-fg,#232723);--muted:var(--magpie-muted,#838b84);--line:var(--magpie-line,#e6eae5);--accent:var(--magpie-accent,#29875a);--selected:var(--magpie-accent-soft,#e4f2e9)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1500px;margin:auto;padding:32px 36px;display:grid;grid-template-columns:272px minmax(0,1fr);gap:36px}.sidebar{min-width:0;position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}.brand{margin-bottom:18px}.eyebrow{color:var(--accent);font-size:10px;letter-spacing:.14em;font-weight:750}h1{font-size:23px;letter-spacing:-.04em;margin:2px 0}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:24px 0}.stat{text-decoration:none;color:inherit}.stats strong{display:block;font-size:21px;line-height:1.2}.stats span,.hint{font-size:11px;color:var(--muted)} .heat-head{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:11px;font-weight:600}.month-nav{display:flex;align-items:center;gap:9px}.month-nav a{color:var(--muted);text-decoration:none;font-size:18px;line-height:1}.month-nav strong{font-size:11px;color:var(--fg)}.weekdays,.heatmap{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}.weekdays{margin-top:10px;text-align:center;font-size:10px;color:var(--muted)}.heatmap{margin-top:5px}.heat,.calendar-spacer{aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:5px;font-size:11px}.heat{text-decoration:none;color:var(--muted);background:#e9ece8}.level-1{background:#b9e1c9;color:#204d33}.level-2{background:#86cda3;color:#204d33}.level-3{background:#54b87e;color:#fff}.level-4{background:#288b59;color:#fff}.heat.selected{outline:2px solid var(--accent);outline-offset:1px}.navigation{margin-top:24px;display:grid;gap:3px;padding:0 0 16px;border-bottom:1px solid var(--line)}a{color:inherit}.nav-item,.filter-item{display:block;text-decoration:none;color:var(--fg);padding:8px 10px;border-radius:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nav-item.active,.filter-item.active{background:var(--selected);color:var(--accent);font-weight:650}.nav-item:hover,.filter-item:hover{background:var(--selected)}.group{margin:16px 0}.group summary{cursor:pointer;color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.06em;list-style:none;display:flex;justify-content:space-between;margin-bottom:6px}.group .filter-item{font-size:13px;padding:5px 10px}.tag-row{display:flex;align-items:center}.tag-row a{flex:1}.pin-tag{border:0;background:none;color:var(--muted);cursor:pointer}.main{min-width:0}.main-head{position:sticky;top:0;z-index:4;display:flex;justify-content:space-between;align-items:center;gap:16px;margin:0 0 13px;padding:16px 0 12px;background:var(--bg)}.heading-row{display:flex;align-items:center;gap:12px}.sort-order{color:var(--muted);text-decoration:none;font-size:18px;line-height:1;padding:4px 6px;border-radius:6px}.sort-order:hover{color:var(--accent);background:var(--selected)}.search-form{display:flex;align-items:center;max-width:260px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.search-form input{min-width:0;width:100%;padding:8px 10px;color:var(--fg);background:transparent;border:0;outline:0;font:inherit;font-size:13px}.search-form:focus-within{border-color:var(--accent)}.search-form button{border:0;background:transparent;color:var(--muted);font-size:19px;cursor:pointer;padding:3px 9px}.range-menu{position:relative}.range-menu summary{cursor:pointer;list-style:none;color:var(--fg);font-size:16px;font-weight:500;padding:4px 0;border-radius:4px}.range-menu summary::-webkit-details-marker{display:none}.range-menu summary span{font-size:13px;color:var(--muted);margin-left:4px}.range-menu summary:hover{color:var(--accent)}.range-options{position:absolute;top:100%;left:0;z-index:5;min-width:120px;padding:4px;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px #0002}.range-option{display:block;padding:6px 10px;text-decoration:none;font-size:13px;font-weight:400;white-space:nowrap;border-radius:6px}.range-option:hover,.range-option.active{background:var(--selected);color:var(--accent)}.main-head h2{font-size:23px;letter-spacing:-.03em;margin:0}.main-head p{color:var(--muted);margin:3px 0 0;font-size:12px}.head-actions{display:flex;gap:8px}.top-button{padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);text-decoration:none;white-space:nowrap}.filter-chip{display:inline-block;margin-left:5px;padding:2px 6px;border-radius:5px;background:var(--selected);color:var(--accent)}.review-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:14px}.review-summary strong{font-size:12px;color:var(--muted)}.review-summary .meta{margin:8px 0 0}.cards{display:grid;gap:14px}.card,.empty{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 2px 8px #00000007}.card{padding:20px 24px}.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.card-head time{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}.actions{display:flex;align-items:center;gap:5px}.action,.more summary,.menu button,.tag-editor button{border:1px solid var(--line);background:transparent;color:var(--muted);padding:5px 10px;border-radius:7px;font:inherit;font-size:12px;cursor:pointer}.favorite{font-size:17px;line-height:1;color:var(--accent)}.more{position:relative}.more summary{list-style:none}.menu{position:absolute;right:0;top:34px;z-index:3;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:4px;box-shadow:0 6px 24px #0002;min-width:105px}.menu button{display:block;border:0;width:100%;text-align:left;white-space:nowrap}.meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.meta>span{font-size:11px;color:var(--accent);background:var(--selected);padding:3px 8px;border-radius:6px}.card-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px}.card-tags .tag{display:inline-flex;align-items:center;padding:3px 8px;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:12px}.tag button{border:0;background:none;color:inherit;cursor:pointer;padding:0 0 0 3px}.prompt{font-size:15px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere}.attachment-label{display:inline-flex;align-items:center;gap:4px;vertical-align:baseline;padding:1px 6px;border:1px solid var(--line);border-radius:5px;color:var(--muted);font-size:12px;line-height:1.5}.pictures{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.image-preview{border:0;padding:0;border-radius:10px;background:transparent;cursor:zoom-in}.image-preview:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.image-dialog{position:fixed;inset:0;max-width:100vw;max-height:100vh;width:100%;height:100%;margin:auto;padding:48px;border:0;background:transparent;overflow:auto}.image-dialog[open]{display:flex;align-items:center;justify-content:center}.image-dialog::backdrop{background:#000c}.image-dialog img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}.preview-prev,.preview-next{position:fixed;top:50%;transform:translateY(-50%);width:42px;height:48px;border:0;border-radius:8px;background:#222b;color:white;font-size:32px;line-height:1;cursor:pointer}.preview-prev{left:16px}.preview-next{right:16px}.preview-prev:disabled,.preview-next:disabled{opacity:.3;cursor:default}.preview-count{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:3px 10px;border-radius:12px;background:#222b;color:white;font-size:12px}.close-preview{position:fixed;right:24px;top:20px;width:36px;height:36px;border:0;border-radius:50%;background:#222b;color:white;font-size:26px;line-height:1;cursor:pointer}.pictures img{display:block;width:72px;height:72px;object-fit:cover;border-radius:10px;background:var(--bg)}.source{color:var(--muted);font-size:11px;margin-top:16px}.source summary{cursor:pointer}.source pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;color:var(--fg);background:var(--bg);padding:12px;border-radius:8px}.template-editor{margin-top:14px}.template-editor input,.template-editor textarea{display:block;width:100%;font:inherit;border:1px solid var(--line);border-radius:6px;padding:8px;background:var(--bg);color:var(--fg);margin-bottom:8px}.template-editor p{font-size:11px;color:var(--muted)}.template-editor button{font:inherit;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:7px;padding:5px 10px;cursor:pointer}.tag-editor{margin-top:12px}.tag-editor input{font:inherit;border:1px solid var(--line);border-radius:6px;padding:6px;max-width:160px;background:var(--bg);color:var(--fg)}.empty{text-align:center;color:var(--muted);padding:50px}.empty strong{color:var(--fg)}.pager{display:flex;justify-content:center;gap:20px;margin:22px;color:var(--muted)}@media(max-width:700px){.shell{grid-template-columns:minmax(125px,155px) minmax(0,1fr);gap:16px;padding:16px 12px}.sidebar{top:12px;max-height:calc(100vh - 24px)}.stats{gap:3px}.stats strong{font-size:16px}.stats span{font-size:10px}.heat,.calendar-spacer{font-size:9px}.main-head{align-items:start}.search-form{max-width:145px}.heading-row{flex-wrap:wrap;gap:3px}.main-head h2{font-size:18px}.card{padding:14px}.pictures img{width:60px;height:60px}}:root[data-theme="dark"]{--bg:var(--magpie-bg,#171a17);--panel:var(--magpie-card,#202420);--fg:var(--magpie-fg,#edf1ed);--muted:var(--magpie-muted,#9aa69d);--line:var(--magpie-line,#343c35);--accent:var(--magpie-accent,#8dd4a8);--selected:var(--magpie-accent-soft,#293c30)}:root[data-theme="dark"] .heat.level-0{background:#313831;color:var(--muted)}@media(prefers-color-scheme:dark){:root:not([data-theme]){--bg:#171a17;--panel:#202420;--fg:#edf1ed;--muted:#9aa69d;--line:#343c35;--accent:#8dd4a8;--selected:#293c30}:root:not([data-theme]) .heat.level-0{background:#313831;color:var(--muted)}}
`;
