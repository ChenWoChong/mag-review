import { entryImages } from './diary.js';
import { prepareT3Images } from './t3-image-markup.js';
import { highlightText, renderMarkdown } from './prompt-markdown.js';
import { annotate, localDate } from './records.js';
import { dirname } from 'node:path';

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
  if ('page' in changes && !changes.page && !('after' in changes)) q.delete('after');
  for (const [key, value] of Object.entries(changes)) {
    if (value) q.set(key, value);
    else q.delete(key);
  }
  const s = q.toString();
  return `/${s ? `?${esc(s)}` : ''}`;
}
const projectKey = record => record.projectId || record.project;
const agentKey = record => record.agent || 'unknown';

function resolveProject(records, value) {
  if (!value || records.some(record => projectKey(record) === value)) return value;
  const aliases = new Set(records.filter(record => record.project === value || (record.cwd && `path:${record.cwd}` === value)).map(projectKey));
  return aliases.size === 1 ? aliases.values().next().value : value;
}

function filterScope(records, data, params) {
  const view = params.get('view') || 'all';
  const start = rangeStart(params.get('range'));
  const query = (params.get('q') || '').trim().toLocaleLowerCase();
  const day = today();
  const week = before(6);
  const date = params.get('date');
  const tag = params.get('tag');
  return records.filter(record => {
    const mark = annotate(record, data);
    if (view === 'hidden' ? !mark.hidden : mark.hidden) return false;
    if (view === 'today' && record.day !== day) return false;
    if (view === 'week' && record.day < week) return false;
    if (start && (record.day < start || record.day > day)) return false;
    if (query && !record.text.toLocaleLowerCase().includes(query)) return false;
    if (view === 'images' && !record.hasImage) return false;
    if (view === 'favorites' && !mark.favorite) return false;
    if (date && record.day !== date) return false;
    if (tag && !mark.tags.includes(tag)) return false;
    return true;
  });
}

function facetCounts(records, key) {
  const counts = new Map();
  for (const record of records) {
    const value = key(record);
    if (!counts.has(value)) counts.set(value, { count: 0, latest: record.submittedAt });
    counts.get(value).count++;
  }
  return counts;
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

function card(entry, data, directory, query) {
  const mark = annotate(entry, data), ids = esc(entry.id);
  const previews = entryImages(entry, directory);
  const images = new Map(previews.map(image => [image.id, image.src]));
  const renderAttachment = attachment => {
    const content = highlightText(attachment.name, query);
    return images.has(attachment.id)
      ? `<button type="button" class="attachment-label image-preview" data-image-id="${esc(attachment.id)}" aria-haspopup="dialog">${content}</button>`
      : `<span class="attachment-label">${content}</span>`;
  };
  const prepared = prepareT3Images(entry.text, entry.attachments);
  const shown = new Set();
  const text = renderMarkdown(prepared.text, { query, imageForRef(ref) {
    const attachment = prepared.byRef.get(ref);
    if (!attachment) return '';
    shown.add(attachment.id);
    return renderAttachment(attachment);
  } });
  const attachments = entry.attachments.filter(attachment => !shown.has(attachment.id)).map(renderAttachment).join('');
  const sources = { message_id: 'Magpie 网关 · 消息 ID', legacy_gateway_hook: 'Magpie 网关 · 旧钩子回填' };
  const source = sources[entry.evidence] || 'Magpie 网关 · 输入边界';
  const pictures = images.size ? `<div class="pictures" hidden>${[...images].map(([id, src]) => `<button type="button" class="image-preview" data-image-id="${esc(id)}" aria-label="放大查看图片" aria-haspopup="dialog"><img src="${src}" data-gallery-image="${esc(id)}" alt="Prompt 附件" loading="lazy"></button>`).join('')}</div>` : '';
  const tags = mark.tags.map(tag => `<span class="tag">${esc(tag)} <button type="button" class="untag" data-ids="${ids}" data-tag="${esc(tag)}" aria-label="移除标签 ${esc(tag)}">×</button></span>`).join('');
  return `<div class="timeline-row"><time class="timeline-time" datetime="${esc(entry.day)}T${esc(entry.time)}">${esc(entry.time)}</time><article class="card">${text ? `<div class="prompt">${text}</div>` : ''}${attachments ? `<div class="attachment-list">${attachments}</div>` : ''}${pictures}<div class="tag-editor" hidden><input type="text" maxlength="32" placeholder="输入标签名称" aria-label="标签名称"><button type="button" class="save-tag" data-ids="${ids}">保存</button><button type="button" class="cancel-tag">取消</button></div>${templateEditor(entry.id)}<div class="card-footer" hidden><div class="card-tags"><span class="tag">${esc(entry.agent || '未知 Agent')}</span><span class="tag" title="${esc(entry.cwd || '未知项目')}">${esc(entry.project)}</span>${tags}</div><details class="source"><summary>来源：${esc(source)} · 查看原文和来源</summary><div>工作目录：${esc(entry.cwd || '未知')}</div>${entry.session ? `<div>会话：${esc(entry.session)}</div>` : ''}<pre>${esc(entry.text)}</pre></details></div></article><details class="more timeline-actions"><summary aria-label="更多操作${mark.favorite ? '，已收藏' : ''}" title="${mark.favorite ? '更多操作 · 已收藏' : '更多操作'}"${mark.favorite ? ' class="is-favorite"' : ''}>···</summary><div class="menu">${entry.text.trim() ? `<button class="copy" type="button" data-copy="${esc(entry.text)}">复制原文</button>` : ''}<button class="favorite" type="button" data-ids="${ids}" data-value="${!mark.favorite}">${mark.favorite ? '取消收藏' : '收藏'}</button><button type="button" class="toggle-card-info" aria-expanded="false">显示详情</button><button type="button" class="add-tag" data-ids="${ids}">添加标签</button>${entry.text.trim() ? `<button type="button" class="edit-template" data-id="${esc(entry.id)}">保存为模板</button>` : ''}<button type="button" class="hide-record" data-ids="${ids}" data-value="${!mark.hidden}">${mark.hidden ? '恢复显示' : '隐藏此条'}</button></div></details></div>`;
}

function templateEditor(id) {
  return `<div class="template-editor" hidden><input maxlength="80" placeholder="模板名称" aria-label="模板名称"><textarea maxlength="200000" rows="8" placeholder="编辑模板内容" aria-label="模板内容"></textarea><p>可以把项目名等内容替换为占位符，例如 {项目名}。</p><button type="button" class="save-template" data-id="${esc(id)}">保存模板</button><button type="button" class="cancel-template">取消</button></div>`;
}

function templateCard(id, template) {
  return `<article class="card"><div class="card-head"><strong>${esc(template.title)}</strong><div class="actions"><button class="copy action" type="button" data-copy="${esc(template.text)}">复制</button><button class="edit-template action" type="button" data-id="${esc(id)}" data-title="${esc(template.title)}">编辑</button><button class="delete-template action" type="button" data-id="${esc(id)}">删除模板</button></div></div><div class="prompt">${renderMarkdown(template.text)}</div>${templateEditor(id)}</article>`;
}

function reviewPage(review, records, data) {
  const { day, kind, models, selected, report, job, scope } = review;
  const options = models.map(model => `<option value="${esc(model)}"${model === selected ? ' selected' : ''}>${esc(model)}</option>`).join('');
  const sources = new Map(records.map(record => [record.id, record]));
  const labels = { issues: '今日核心问题', corrections: kind === 'weekly' ? '跨日重复提醒与规则建议' : '重复纠偏线索', templates: '值得复用的 Prompt' };
  const evidence = ids => `<details class="review-evidence"><summary>查看原始 Prompt（${ids.length}）</summary>${ids.map(id => {
    const record = sources.get(id);
    return record ? `<div class="evidence-item"><div>${esc(record.day)} ${esc(record.time)} · ${esc(record.project)} · ${esc(record.agent)}</div><pre>${esc(record.text)}</pre></div>` : '<p>原始记录已不可用</p>';
  }).join('')}</details>`;
  const sections = report ? Object.entries(labels).filter(([key]) => kind !== 'weekly' || key === 'corrections').map(([key, title]) => {
    const items = report.sections[key] || [];
    const renderItem = item => {
      const feedback = data.feedback?.[item.id];
      const actions = key === 'templates' ? `<div class="review-actions">${feedback === 'saved' ? '<span>已保存到模板并收藏</span>' : feedback === 'dismissed' ? '<span>已标记不值得</span>' : `<button type="button" class="review-feedback" data-value="saved" data-id="${esc(item.id)}">收藏并保存为模板</button><button type="button" class="review-feedback" data-value="dismissed" data-id="${esc(item.id)}">不值得</button>`}</div>` : '';
      const dates = new Set(item.sources.map(id => sources.get(id)?.day).filter(Boolean));
      const support = kind === 'weekly' ? `<span class="review-support">${dates.size} 天 · ${item.sources.length} 条依据</span>` : '';
      const copyRule = kind === 'weekly' ? `<div class="review-actions"><button type="button" class="copy" data-copy="${esc(item.detail)}">复制建议</button></div>` : '';
      return `<article class="review-item"><strong>${esc(item.title)}</strong>${support}<p>${esc(item.detail)}</p>${evidence(item.sources)}${actions}${copyRule}</article>`;
    };
    let content = '<p class="review-hint">暂无符合条件的内容。</p>';
    if (items.length && key === 'issues') {
      const projects = new Map();
      for (const item of items) {
        const names = [...new Set(item.sources.map(id => sources.get(id)?.project).filter(Boolean))];
        const project = names.length === 1 ? names[0] : names.length > 1 ? '跨项目' : '未知项目';
        if (!projects.has(project)) projects.set(project, []);
        projects.get(project).push(item);
      }
      content = [...projects].map(([project, group]) => `<div class="review-project-group"><h4>${esc(project)}</h4>${group.map(renderItem).join('')}</div>`).join('');
    } else if (items.length) content = items.map(renderItem).join('');
    return `<section class="review-section"><h3>${title}</h3>${content}</section>`;
  }).join('') : `<div class="empty"><strong>还没有${kind === 'weekly' ? '跨日复盘' : '今日复盘'}</strong><p>选择模型后点击生成，结果会保存在本机。</p></div>`;
  const status = job?.state === 'running' ? '正在生成，请稍候…' : job?.state === 'error' ? `生成失败：${esc(job.error)}` : '';
  return `<div class="review-page"><header class="review-header"><h2>复盘与沉淀</h2><p>依据已收录的用户 Prompt，总结问题与要求；不判断任务是否完成，也不会自动修改规则文件。</p></header><form class="review-scope" method="get"><input type="hidden" name="view" value="review"><label>日期 <input type="date" name="reviewDate" value="${esc(day)}" required></label><label>范围 <select name="reviewKind"><option value="daily"${kind === 'daily' ? ' selected' : ''}>当天</option><option value="weekly"${kind === 'weekly' ? ' selected' : ''}>近 7 天</option></select></label><button type="submit">查看</button></form><p class="review-meta">${scope ? `生成范围：${esc(scope.from)} 至 ${esc(day)} · ${scope.total} 条可用，将分析 ${scope.included} 条${scope.truncated ? ` · ${scope.truncated} 条未完整纳入` : ''}` : '日期无效'}</p><div class="review-generate" data-running="${job?.state === 'running' ? 'true' : 'false'}"><label>生成模型 <select class="review-model" aria-label="生成模型">${options || '<option value="">无可用模型</option>'}</select></label><button type="button" class="generate-review" data-day="${esc(day)}" data-kind="${esc(kind)}"${!models.length || !scope?.included || job?.state === 'running' ? ' disabled' : ''}>${report ? '重新生成' : '生成复盘'}</button><span class="review-status" role="status">${status}</span><p>点击生成后，所选范围内的 Prompt 文本会发送给所选模型；不包含图片。最多分析 250 条，每条最多 6000 字符，总计最多 180000 字符。</p></div>${report ? `<p class="review-meta">${esc(report.from)} 至 ${esc(report.day)} · 已收录 ${report.total} 条，分析 ${report.included} 条${report.truncated ? ` · ${report.truncated} 条未完整纳入` : ''} · ${esc(report.model)} · ${esc(new Date(report.generatedAt).toLocaleString('zh-CN'))}</p>` : ''}${sections}<div class="review-template-link"><a href="/?view=templates">查看已保存的 Prompt 模板 →</a></div></div>`;
}

export async function renderPage({ records, data, directory, params, nonce, token, review }) {
  const visible = records.filter(record => !annotate(record, data).hidden);
  const view = params.get('view') || 'all';
  const icon = (path) => `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const icons = {
    all: icon('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/>'),
    images: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 18 5-5 3 3 3-4 5 6"/>'),
    favorites: icon('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>'),
    review: icon('<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/>'),
    templates: icon('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
    project: icon('<path d="M3 7h7l2 2h9v10H3z"/>'),
    agent: icon('<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 4v3M9 12h.01M15 12h.01M9 16h6"/>'),
    tag: icon('<path d="M3 12V5h7l10 10-6 6z"/><circle cx="7.5" cy="8.5" r="1"/>'),
  };
  const nav = [['all','全部'],['images','有图片'],['favorites','已收藏']];
  const ranges = [['','全部'],['today','当天'],['this-week','本周'],['last-7','近 7 天'],['month','近一个月']];
  const range = ranges.find(([id]) => id === (params.get('range') || '')) || ranges[0];
  const rangeMenu = ranges.map(([id, label]) => `<a class="range-option${range[0] === id ? ' active' : ''}" href="${url(params, { range: id, date: '', page: '' })}"${range[0] === id ? ' aria-current="true"' : ''}>${label}</a>`).join('');
  const navHTML = nav.map(([id, title]) => `<a class="nav-item${view === id ? ' active' : ''}" href="${url(params, { view: id === 'all' ? '' : id, ...(id === 'all' ? { date: '' } : {}), page: '' })}">${icons[id]}<span>${title}</span></a>`).join('');
  const currentAgent = params.get('agent');
  const currentProject = resolveProject(records, params.get('project'));
  const inProject = record => !currentProject || projectKey(record) === currentProject;
  const byAgent = record => !currentAgent || agentKey(record) === currentAgent;
  const scope = filterScope(records, data, params);
  const projectCounts = facetCounts(scope.filter(byAgent), projectKey);
  const agentCounts = facetCounts(scope.filter(inProject), agentKey);
  const facetRecords = view === 'hidden' ? records.filter(record => annotate(record, data).hidden) : visible;
  const facetView = view === 'templates' || view === 'review' ? '' : view;
  const facetHref = (key, value) => url(params, { [key]: value, view: facetView === 'all' ? '' : facetView, page: '' });
  const projectMap = new Map();
  for (const record of facetRecords) {
    const id = projectKey(record);
    if (projectMap.has(id)) continue;
    const match = projectCounts.get(id);
    projectMap.set(id, {
      id, name: record.project, path: record.projectPath, kind: record.projectKind,
      count: match?.count || 0, latest: record.submittedAt, latestMatch: match?.latest || '',
    });
  }
  const projectTotal = projectMap.size;
  if (currentProject && !projectMap.has(currentProject)) {
    projectMap.set(currentProject, { id: currentProject, name: params.get('project'), count: 0, latest: '', latestMatch: '' });
  }
  const projects = [...projectMap.values()].sort((a, b) =>
    b.latestMatch.localeCompare(a.latestMatch) || b.latest.localeCompare(a.latest) || a.name.localeCompare(b.name, 'zh-CN')
  );
  const isCurrentProject = project => currentProject === project.id;
  const nameCounts = new Map();
  for (const project of projects) nameCounts.set(project.name, (nameCounts.get(project.name) || 0) + 1);
  const projectLink = project => {
    const current = isCurrentProject(project);
    const parent = nameCounts.get(project.name) > 1 && project.path ? dirname(project.path) : '';
    const kind = { directory: '其他目录', unconfirmed: '路径未确认', unknown: '未归类' }[project.kind];
    const detail = [parent, kind].filter(Boolean).join(' · ');
    return `<a class="filter-item project-item local-filter${current ? ' active' : ''}"${current ? ' aria-current="true"' : ''} title="${esc(project.path || project.name)}${kind ? ` · ${kind}` : ''}" href="${facetHref('project', current ? '' : project.id)}"><span class="project-name">${esc(project.name)}${detail ? `<small>${esc(detail)}</small>` : ''}</span><span class="project-count">${project.count}</span></a>`;
  };
  const initial = projects.filter(project => project.count).slice(0, 6);
  const selected = projectMap.get(currentProject);
  if (selected && !initial.includes(selected)) initial.push(selected);
  const extra = projects.filter(project => !initial.includes(project));
  const projectGroup = `<details class="group" id="project-filters"${currentProject ? ' open' : ''}><summary><span class="group-title">${icons.project}项目</span><span class="group-count" title="当前匹配项目数 / 全部历史项目数">${projectCounts.size} / ${projectTotal} <span class="group-chevron" aria-hidden="true">⌄</span></span></summary><div class="filter-list">${projectCounts.size ? '' : '<span class="hint">当前筛选无匹配项目</span>'}${initial.map(projectLink).join('')}${extra.length ? `<details class="project-more"><summary>更多项目（${extra.length}）</summary>${extra.map(projectLink).join('')}</details>` : ''}</div></details>`;
  const agentName = agent => agent === 'unknown' ? '未知 Agent' : agent;
  const agentKeys = new Set(facetRecords.map(agentKey));
  const agentTotal = agentKeys.size;
  if (currentAgent) agentKeys.add(currentAgent);
  const agents = [...agentKeys].sort((a, b) => Number(agentCounts.has(b)) - Number(agentCounts.has(a)) || agentName(a).localeCompare(agentName(b), 'zh-CN'));
  const agentLinks = agents.map(agent => {
    const current = currentAgent === agent;
    return `<a class="filter-item agent-item local-filter${current ? ' active' : ''}"${current ? ' aria-current="true"' : ''} href="${facetHref('agent', current ? '' : agent)}"><span>${esc(agentName(agent))}</span><span class="agent-count">${agentCounts.get(agent)?.count || 0}</span></a>`;
  }).join('');
  const agentGroup = `<details class="group" id="agent-filters"${currentAgent ? ' open' : ''}><summary><span class="group-title">${icons.agent}Agent</span><span class="group-count" title="当前匹配 Agent 数 / 全部历史 Agent 数">${agentCounts.size} / ${agentTotal} <span class="group-chevron" aria-hidden="true">⌄</span></span></summary><div class="filter-list">${agentCounts.size ? '' : '<span class="hint">当前筛选无匹配 Agent</span>'}${agentLinks}</div></details>`;
  const tags = [...new Set(visible.flatMap(r => annotate(r, data).tags))].sort((a,b) => a.localeCompare(b, 'zh-CN'));
  const tagLinks = tags.sort((a,b) => Number(data.pinned.includes(b)) - Number(data.pinned.includes(a))).map(tag => `<div class="tag-row"><a class="filter-item${params.get('tag') === tag ? ' active' : ''}" href="${url(params, { tag: params.get('tag') === tag ? '' : tag, date: '', page: '' })}"># ${esc(tag)}</a><button class="pin-tag" data-tag="${esc(tag)}" data-value="${!data.pinned.includes(tag)}" title="${data.pinned.includes(tag) ? '取消置顶' : '置顶标签'}">${data.pinned.includes(tag) ? '★' : '☆'}</button></div>`).join('');
  let list = view === 'templates' || review ? [] : scope.filter(record => inProject(record) && byAgent(record));
  if (params.get('sort') === 'asc') list.reverse();
  if (view === 'random' && list.length) list = [list[Math.floor(Math.random() * list.length)]];
  const templates = view === 'templates' ? Object.entries(data.templates || {}) : [];
  const total = view === 'templates' ? templates.length : list.length, pages = Math.max(1, Math.ceil(total / 30));
  const page = Math.min(pages, Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1));
  const after = params.get('after');
  const cursorIndex = after ? (view === 'templates' ? templates.findIndex(([id]) => id === after) : list.findIndex(record => record.id === after)) : -1;
  const cursorMissing = Boolean(after && cursorIndex < 0);
  const start = cursorMissing ? total : after ? cursorIndex + 1 : (page - 1) * 30;
  const pageRecords = list.slice(start, start + 30);
  const pageTemplates = templates.slice(start, start + 30);
  const items = view === 'templates'
    ? pageTemplates.map(([id, template]) => templateCard(id, template))
    : pageRecords.map(r => card(r, data, directory, (params.get('q') || '').trim()));
  let content = '';
  if (view === 'templates') content = `<div class="cards">${items.join('')}</div>`;
  else {
    let day = '';
    content = items.map((item, i) => {
      const current = pageRecords[i].day;
      if (current === day) return item;
      const closing = day ? '</section>' : '';
      day = current;
      return `${closing}<section class="timeline-day" data-day="${esc(current)}"><h3 class="timeline-date">${esc(current)}</h3>${item}`;
    }).join('') + (day ? '</section>' : '');
  }
  const text = items.length ? content : `<div class="empty"><strong>这里还没有记录</strong><p>试试其他日期或筛选条件。</p></div>`;
  const lastId = view === 'templates' ? pageTemplates.at(-1)?.[0] : pageRecords.at(-1)?.id;
  const pager = cursorMissing ? '<div class="cursor-expired">记录已变化，请刷新页面后重试。</div>' : lastId && start + items.length < total ? `<div class="load-more-sentinel" data-next="${url(params, { after: lastId, page: '' })}" role="status"><span>正在加载更多…</span><button type="button" class="load-retry" hidden>重试</button></div>` : '';
  const facetChip = (key, value, label) => value ? `<a class="filter-chip local-filter" href="${facetHref(key, '')}" aria-label="${label}">${esc(value)} ×</a>` : '';
  const filterLabels = [
    params.get('date') ? `<span class="filter-chip">${esc(params.get('date'))}</span>` : '',
    facetChip('agent', currentAgent && agentName(currentAgent), '清除 Agent 筛选'),
    facetChip('project', selected?.name, '清除项目筛选'),
    params.get('tag') ? `<span class="filter-chip">#${esc(params.get('tag'))}</span>` : '',
  ].join('');
  const dateCount = new Set(visible.map(r => r.day)).size;
  const mainContent = view === 'review' && review ? reviewPage(review, records, data) : `<header class="main-head${view === 'templates' ? '' : ' timeline-head'}"><div><div class="heading-row"><details class="range-menu"><summary aria-label="选择时间范围">${range[1]} <span aria-hidden="true">⌄</span></summary><div class="range-options">${rangeMenu}</div></details><a class="sort-order local-filter" href="${url(params, { sort: params.get('sort') === 'asc' ? '' : 'asc', page: '' })}" aria-label="${params.get('sort') === 'asc' ? '当前时间正序，点击切换为倒序' : '当前时间倒序，点击切换为正序'}" title="${params.get('sort') === 'asc' ? '时间正序：最早在前' : '时间倒序：最新在前'}"><span aria-hidden="true">${params.get('sort') === 'asc' ? '↑' : '↓'}</span></a></div><p>${total} 条记录 ${filterLabels}</p></div><form class="search-form" role="search"><input type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="搜索 Prompt" aria-label="搜索 Prompt" autocomplete="off"><button type="submit" aria-label="搜索">⌕</button></form></header>${text}${pager}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prompt 日记</title><style>${styles}</style></head><body data-token="${esc(token)}"><main class="shell"><aside class="sidebar"><div class="brand"><div class="eyebrow">PROMPT DIARY</div></div><div class="stats"><a href="/" class="stat"><strong>${visible.length}</strong><span>已收录</span></a><a href="#calendar" class="stat"><strong>${dateCount}</strong><span>记录天数</span></a><a href="#project-filters" class="stat project-shortcut"><strong>${projectTotal}</strong><span>历史项目</span></a></div>${heatmap(visible, params)}<nav class="navigation" aria-label="记录视图">${navHTML}</nav><div class="review-navigation"><a class="nav-item${view === 'review' ? ' active' : ''}" href="/?view=review">${icons.review}<span>复盘与沉淀</span></a><a class="nav-item${view === 'templates' ? ' active' : ''}" href="/?view=templates">${icons.templates}<span>Prompt 模板</span></a></div>${projectGroup}${agentGroup}<details class="group" id="tag-filters"${params.get('tag') ? ' open' : ''}><summary><span class="group-title">${icons.tag}标签</span><span class="group-count">${tags.length} <span class="group-chevron" aria-hidden="true">⌄</span></span></summary><div class="filter-list">${tagLinks || '<span class="hint">在卡片上添加标签</span>'}</div></details></aside><section class="main">${mainContent}</section></main><button type="button" class="selection-copy" hidden aria-live="polite">复制选中文字</button><dialog class="image-dialog" aria-label="图片预览"><button type="button" class="close-preview" aria-label="关闭图片预览">×</button><button type="button" class="preview-prev" aria-label="上一张图片">‹</button><img alt="放大的 Prompt 附件"><button type="button" class="preview-next" aria-label="下一张图片">›</button><div class="preview-count" aria-live="polite"></div></dialog><script nonce="${nonce}">${client}</script></body></html>`;
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
let searchTimer, loadObserver;
function initInfiniteScroll() {
  loadObserver?.disconnect();
  const sentinel = document.querySelector('.load-more-sentinel');
  if (!sentinel) return;
  if (typeof IntersectionObserver === 'undefined') {
    sentinel.querySelector('span').textContent = '';
    sentinel.querySelector('.load-retry').hidden = false;
    sentinel.querySelector('.load-retry').textContent = '加载更多';
    return;
  }
  loadObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) loadMore(sentinel);
  }, { rootMargin: '400px 0px' });
  loadObserver.observe(sentinel);
}
async function loadMore(sentinel) {
  if (sentinel.dataset.loading === 'true') return;
  sentinel.dataset.loading = 'true';
  sentinel.querySelector('span').textContent = '正在加载更多…';
  sentinel.querySelector('.load-retry').hidden = true;
  const sequence = filterSequence;
  try {
    const response = await fetch('/filter', { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({ path:sentinel.dataset.next, token:document.body.dataset.token }) });
    if (!response.ok) throw new Error('加载失败');
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (sequence !== filterSequence || !sentinel.isConnected) return;
    const nextMain = page.querySelector('.main'), main = document.querySelector('.main');
    if (!nextMain || !main || nextMain.querySelector('.cursor-expired')) throw new Error('记录已变化，请刷新页面');
    const groups = [...nextMain.querySelectorAll('.timeline-day')];
    const nextCards = nextMain.querySelector('.cards');
    if (!groups.length && !nextCards) throw new Error('加载失败');
    for (const group of groups) {
      const existing = [...main.querySelectorAll('.timeline-day')].at(-1);
      if (existing && existing.dataset.day === group.dataset.day) {
        for (const row of [...group.querySelectorAll('.timeline-row')]) existing.appendChild(row);
      } else sentinel.before(group);
    }
    if (nextCards) {
      const existing = main.querySelector('.cards');
      if (!existing) throw new Error('加载失败');
      for (const card of [...nextCards.children]) existing.appendChild(card);
    }
    const next = nextMain.querySelector('.load-more-sentinel');
    if (!next) { sentinel.remove(); loadObserver?.disconnect(); }
    else { sentinel.dataset.next = next.dataset.next; sentinel.dataset.loading = 'false'; initInfiniteScroll(); }
  } catch (error) {
    if (sequence !== filterSequence || !sentinel.isConnected) return;
    loadObserver?.disconnect();
    sentinel.dataset.loading = 'false';
    sentinel.querySelector('span').textContent = (error.message || '加载失败') + '，可重试或刷新页面。';
    sentinel.querySelector('.load-retry').hidden = false;
  }
}

async function selectRange(path, addHistory = true, replaceHistory = false) {
  const sequence = ++filterSequence;
  const menu = document.querySelector('.range-menu');
  if (menu) menu.open = false;
  const response = await fetch('/filter', { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({ path, token:document.body.dataset.token }) });
  if (!response.ok) throw new Error('筛选失败');
  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  if (sequence !== filterSequence) return;
  const oldSidebar = document.querySelector('.sidebar'), nextSidebar = page.querySelector('.sidebar');
  const oldMain = document.querySelector('.main'), nextMain = page.querySelector('.main');
  if (!oldSidebar || !nextSidebar || !oldMain || !nextMain) throw new Error('筛选失败');
  const scroll = oldSidebar.scrollTop;
  const moreOpen = oldSidebar.querySelector?.('.project-more')?.open;
  const opened = new Map([...oldSidebar.querySelectorAll('details.group')].map(group => [group.id, group.open]));
  nextSidebar.querySelectorAll('details.group').forEach(group => {
    group.open = opened.get(group.id) ?? group.open;
  });
  if (moreOpen && nextSidebar.querySelector?.('.project-more')) nextSidebar.querySelector('.project-more').open = true;
  oldSidebar.replaceWith(nextSidebar);
  nextSidebar.scrollTop = scroll;
  const search = oldMain.querySelector('.search-form input');
  const focused = search && document.activeElement === search;
  const caret = focused ? search.selectionStart : null;
  oldMain.replaceWith(nextMain);
  initInfiniteScroll();
  if (focused) {
    const nextSearch = nextMain.querySelector('.search-form input');
    nextSearch.focus({ preventScroll: true });
    if (caret !== null) try { nextSearch.setSelectionRange(caret, caret); } catch {}
  }
  currentPath = path;
  if (addHistory) { try { history[replaceHistory ? 'replaceState' : 'pushState'](null, '', path); } catch {} }
}
window.addEventListener('popstate', () => { selectRange(location.pathname + location.search, false).catch(() => location.reload()); });
async function reviewAction(action) {
  const response = await fetch('/action', { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({ ...action, token:document.body.dataset.token }) });
  if (!response.ok) throw new Error((await response.text()) || '操作失败');
  return response;
}
async function pollReview() {
  const status = document.querySelector('.review-status');
  if (!status) return;
  try {
    const job = await (await reviewAction({ type:'review-status' })).json();
    if (job.state === 'running') { status.textContent = '正在生成，请稍候…'; setTimeout(pollReview, 1500); }
    else if (job.state === 'done') location.assign(currentPath);
    else { status.textContent = job.error ? '生成失败：' + job.error : ''; const button = document.querySelector('.generate-review'); if (button) button.disabled = false; }
  } catch { status.textContent = '无法获取生成状态，请重新打开页面。'; }
}
if (document.querySelector('.review-generate')?.dataset.running === 'true') setTimeout(pollReview, 0);
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch {}
  const field = document.createElement('textarea');
  field.value = text;
  field.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(field); field.focus(); field.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch {}
  field.remove();
  return copied;
}
let selectedText = '', selectionTimer;
function showSelectionCopy() {
  const button = document.querySelector('.selection-copy'), selection = window.getSelection();
  if (!button || !selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) { if (button) button.hidden = true; selectedText = ''; return; }
  const element = node => node?.nodeType === 1 ? node : node?.parentElement;
  const start = element(selection.anchorNode)?.closest('.prompt');
  const end = element(selection.focusNode)?.closest('.prompt');
  if (!start || start !== end) { button.hidden = true; selectedText = ''; return; }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  selectedText = selection.toString();
  button.hidden = false;
  button.textContent = '复制选中文字';
  const width = button.offsetWidth, height = button.offsetHeight;
  button.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2)) + 'px';
  button.style.top = Math.max(8, rect.top >= height + 8 ? rect.top - height - 6 : Math.min(window.innerHeight - height - 8, rect.bottom + 6)) + 'px';
}
document.addEventListener('mousedown', event => { if (event.target.closest('.selection-copy')) event.preventDefault(); });
document.addEventListener('mouseup', event => { if (!event.target.closest('.selection-copy')) setTimeout(showSelectionCopy, 0); });
document.addEventListener('touchend', event => { if (!event.target.closest('.selection-copy')) setTimeout(showSelectionCopy, 0); });
document.addEventListener('keyup', event => { if (event.shiftKey) setTimeout(showSelectionCopy, 0); });
window.addEventListener('scroll', () => { const button = document.querySelector('.selection-copy'); if (button) button.hidden = true; }, true);
window.addEventListener('resize', () => { const button = document.querySelector('.selection-copy'); if (button) button.hidden = true; });
async function update(action) {
  const response = await fetch('/action', { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({ ...action, token:document.body.dataset.token }) });
  if (!response.ok) throw new Error('保存失败');
  location.assign(currentPath);
}
const menuCloseTimers = new WeakMap();
document.addEventListener('pointerout', event => {
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
  const menu = event.target.closest('.timeline-actions');
  if (!menu?.open || (event.relatedTarget && menu.contains(event.relatedTarget))) return;
  clearTimeout(menuCloseTimers.get(menu));
  menuCloseTimers.set(menu, setTimeout(() => { menu.open = false; menuCloseTimers.delete(menu); }, 180));
});
document.addEventListener('pointerover', event => {
  const menu = event.target.closest('.timeline-actions');
  if (menu && menuCloseTimers.has(menu)) { clearTimeout(menuCloseTimers.get(menu)); menuCloseTimers.delete(menu); }
});
document.addEventListener('click', async event => {
  for (const openMenu of document.querySelectorAll?.('.timeline-actions[open]') || []) if (!openMenu.contains(event.target)) openMenu.open = false;
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
    if (target.classList.contains('load-retry')) { await loadMore(target.closest('.load-more-sentinel')); }
    else if (target.classList.contains('selection-copy')) {
      if (!selectedText) return;
      clearTimeout(selectionTimer);
      const copied = await copyText(selectedText);
      target.textContent = copied ? '已复制' : '复制失败';
      selectionTimer = setTimeout(() => { target.hidden = true; }, 1500);
    } else if (target.classList.contains('generate-review')) {
      const model = document.querySelector('.review-model').value, status = document.querySelector('.review-status');
      target.disabled = true; status.textContent = '正在提交…';
      try { await reviewAction({ type:'review-start', day:target.dataset.day, kind:target.dataset.kind, model }); pollReview(); }
      catch (error) { target.disabled = false; status.textContent = error.message || '生成失败'; }
    } else if (target.classList.contains('review-feedback')) {
      await update({ type:'review-feedback', day:document.querySelector('.generate-review').dataset.day, kind:document.querySelector('.generate-review').dataset.kind, id:target.dataset.id, value:target.dataset.value });
    } else if (target.classList.contains('image-preview')) {
      const images = [...target.closest('.card').querySelectorAll('[data-gallery-image]')];
      const index = images.findIndex(image => image.dataset.galleryImage === target.dataset.imageId);
      if (!dialog || index < 0) return;
      previewImages = images.map(image => image.src);
      showPreview(index);
      dialog.showModal();
    } else if (target.classList.contains('preview-prev')) showPreview(previewIndex - 1);
    else if (target.classList.contains('preview-next')) showPreview(previewIndex + 1);
    else if (target.classList.contains('close-preview')) dialog.close();
    else if (target.classList.contains('copy')) {
      const label = target.textContent;
      const copied = await copyText(target.dataset.copy);
      target.textContent = copied ? '已复制' : '复制失败'; setTimeout(() => { target.textContent = label; }, 2000);
    } else if (target.classList.contains('favorite')) await update({type:'favorite',ids,value:target.dataset.value === 'true'});
    else if (target.classList.contains('hide-record')) await update({type:'hidden',ids,value:target.dataset.value === 'true'});
    else if (target.classList.contains('untag')) await update({type:'tag',ids,tag:target.dataset.tag,value:false});
    else if (target.classList.contains('pin-tag')) await update({type:'pin',tag:target.dataset.tag,value:target.dataset.value === 'true'});
    else if (target.classList.contains('toggle-card-info')) { const row=target.closest('.timeline-row'), footer=row.querySelector('.card-footer'), pictures=row.querySelector('.pictures'); footer.hidden=!footer.hidden; if (pictures) pictures.hidden=footer.hidden; target.textContent=footer.hidden?'显示详情':'隐藏详情'; target.setAttribute('aria-expanded', String(!footer.hidden)); target.closest('.more').open=false; }
    else if (target.classList.contains('add-tag')) { const c=target.closest('.timeline-row').querySelector('.card'); c.querySelector('.tag-editor').hidden=false; target.closest('.more').open=false; c.querySelector('.tag-editor input').focus(); }
    else if (target.classList.contains('cancel-tag')) target.closest('.tag-editor').hidden=true;
    else if (target.classList.contains('save-tag')) { const tag=target.closest('.tag-editor').querySelector('input').value.trim(); if (tag) await update({type:'tag',ids,tag,value:true}); }
    else if (target.classList.contains('edit-template')) {
      const row = target.closest('.timeline-row');
      const card = row ? row.querySelector('.card') : target.closest('.card'), editor = card.querySelector('.template-editor');
      editor.hidden = false; editor.querySelector('input').value = target.dataset.title || '';
      editor.querySelector('textarea').value = (row || card).querySelector('.copy').dataset.copy;
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
  next.searchParams.delete('after');
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
  if (event.target.matches('.review-scope')) {
    event.preventDefault();
    const day = event.target.querySelector('[name="reviewDate"]').value;
    const kind = event.target.querySelector('[name="reviewKind"]').value;
    const next = new URL('/', location.href);
    next.searchParams.set('view', 'review');
    next.searchParams.set('reviewDate', day);
    next.searchParams.set('reviewKind', kind);
    const path = next.pathname + next.search;
    selectRange(path).catch(() => { location.assign(path); });
    return;
  }
  if (!event.target.matches('.search-form')) return;
  event.preventDefault();
  clearTimeout(searchTimer);
  searchFor(event.target.querySelector('input').value);
});
initInfiniteScroll();
document.addEventListener('keydown', event => { if (document.querySelector('.image-dialog')?.open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); showPreview(previewIndex + (event.key === 'ArrowLeft' ? -1 : 1)); return; } if (event.key === 'Escape') { for (const openMenu of document.querySelectorAll?.('.timeline-actions[open]') || []) { openMenu.open = false; openMenu.querySelector('summary')?.focus(); } const menu = document.querySelector('.range-menu'); if (menu?.open) { menu.open = false; menu.querySelector('summary').focus(); } } if (event.key === 'Enter' && event.target.matches('.tag-editor input')) { event.preventDefault(); event.target.parentElement.querySelector('.save-tag').click(); } });
`;

const styles = `
.card .prompt{white-space:normal}
.prompt> :first-child{margin-top:0}.prompt> :last-child{margin-bottom:0}
.prompt p,.prompt ul,.prompt ol,.prompt blockquote,.prompt pre,.prompt table{margin:0 0 10px}
.prompt h1,.prompt h2,.prompt h3,.prompt h4,.prompt h5,.prompt h6{margin:14px 0 6px;font-size:1.12em;line-height:1.35}
.prompt h1,.prompt h2{font-size:1.25em}
.prompt ul,.prompt ol{padding-inline-start:1.6em}
.prompt li>p,.prompt li>ul,.prompt li>ol{margin-bottom:0}
.prompt blockquote{border-inline-start:3px solid var(--line);padding-inline-start:12px;color:var(--muted)}
.prompt blockquote> :last-child{margin-bottom:0}
.prompt hr{border:0;border-top:1px solid var(--line);margin:12px 0}
.prompt code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.88em;background:var(--bg);border-radius:4px;padding:2px 4px}
.prompt pre{overflow-x:auto;white-space:pre;overflow-wrap:normal;border:1px solid var(--line);border-radius:8px;background:var(--bg);padding:10px 12px;line-height:1.6}
.prompt pre code{padding:0;background:transparent}
.prompt table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}
.prompt th,.prompt td{border:1px solid var(--line);padding:4px 8px}
.prompt th{background:var(--bg)}
.prompt a{color:var(--accent);text-underline-offset:2px}
.attachment-list{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.group .filter-item:is(.project-item,.agent-item){display:flex;align-items:center;gap:6px}
.agent-item>span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.agent-count{flex:none;font-size:11px;color:var(--muted);text-align:right}
.filter-chip.local-filter{text-decoration:none}
.filter-chip.local-filter:hover{text-decoration:underline}
.prompt .attachment-label{margin-inline:2px}
button.attachment-label{background:var(--panel);color:var(--accent);font-family:inherit;cursor:zoom-in;max-width:100%;overflow-wrap:anywhere;text-align:left;padding:1px 6px;border:1px solid var(--line);border-radius:5px}
button.attachment-label:hover{background:var(--selected)}
button.attachment-label:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
:root{color-scheme:light dark;--bg:var(--magpie-bg,#f6f7f5);--panel:var(--magpie-card,#fff);--fg:var(--magpie-fg,#232723);--muted:var(--magpie-muted,#838b84);--line:var(--magpie-line,#e6eae5);--accent:var(--magpie-accent,#29875a);--selected:var(--magpie-accent-soft,#e4f2e9)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1500px;margin:auto;padding:32px 36px;display:grid;grid-template-columns:272px minmax(0,1fr);gap:36px}.sidebar{min-width:0;position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;-ms-overflow-style:none}.sidebar::-webkit-scrollbar{display:none}.brand{margin-bottom:18px}.eyebrow{color:var(--accent);font-size:10px;letter-spacing:.14em;font-weight:750}h1{font-size:23px;letter-spacing:-.04em;margin:2px 0}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:24px 0}.stat{text-decoration:none;color:inherit}.stats strong{display:block;font-size:21px;line-height:1.2}.stats span,.hint{font-size:11px;color:var(--muted)} .heat-head{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:11px;font-weight:600}.month-nav{display:flex;align-items:center;gap:9px}.month-nav a{color:var(--muted);text-decoration:none;font-size:18px;line-height:1}.month-nav strong{font-size:11px;color:var(--fg)}.weekdays,.heatmap{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}.weekdays{margin-top:10px;text-align:center;font-size:10px;color:var(--muted)}.heatmap{margin-top:5px}.heat,.calendar-spacer{aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:5px;font-size:11px}.heat{text-decoration:none;color:var(--muted);background:#e9ece8}.level-1{background:#b9e1c9;color:#204d33}.level-2{background:#86cda3;color:#204d33}.level-3{background:#54b87e;color:#fff}.level-4{background:#288b59;color:#fff}.heat.selected{outline:none;box-shadow:inset 0 0 0 2px #1b7148,inset 0 0 0 3px #d9f4e4}.heat:focus-visible{outline:2px solid #1b7148;outline-offset:-2px}.navigation{margin-top:24px;display:grid;gap:3px;padding:0 0 16px;border-bottom:1px solid var(--line)}a{color:inherit}.nav-item,.filter-item{display:block;text-decoration:none;color:var(--muted);padding:7px 10px;border-radius:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nav-item{display:flex;align-items:center;gap:10px}.nav-icon{width:16px;height:16px;flex:none}.nav-item.active,.filter-item.active{background:var(--line);color:var(--fg);font-weight:550}.nav-item:hover,.filter-item:hover{background:var(--line);color:var(--fg)}.group{margin:10px 0}.group summary{cursor:pointer;color:var(--fg);font-size:13px;font-weight:500;list-style:none;display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:8px}.group summary::-webkit-details-marker{display:none}.group summary:hover{background:var(--line)}.group-title{display:flex;align-items:center;gap:10px}.group-count{color:var(--muted);font-size:11px}.group-chevron{display:inline-block;margin-left:5px}.group:not([open]) .group-chevron{transform:rotate(-90deg)}.filter-list{border-left:1px solid var(--line);margin:2px 0 0 17px;padding:0 0 0 8px}.group .filter-item{font-size:13px;padding:5px 10px}.project-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.project-name small{display:block;color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis}.project-count{font-size:11px;color:var(--muted)}.project-more>summary{font-size:11px;color:var(--muted);padding:5px 10px}.tag-row{display:flex;align-items:center}.tag-row a{flex:1}.pin-tag{border:0;background:none;color:var(--muted);cursor:pointer}.main{min-width:0}.main-head{position:sticky;top:0;z-index:4;display:flex;justify-content:space-between;align-items:center;gap:16px;margin:0 0 13px;padding:16px 0 12px;background:var(--bg)}.main-head.timeline-head{padding-right:44px}.heading-row{display:flex;align-items:center;gap:12px}.sort-order{color:var(--muted);text-decoration:none;font-size:18px;line-height:1;padding:4px 6px;border-radius:6px}.sort-order:hover{color:var(--accent);background:var(--selected)}.search-form{display:flex;align-items:center;max-width:260px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.search-form input{min-width:0;width:100%;padding:8px 10px;color:var(--fg);background:transparent;border:0;outline:0;font:inherit;font-size:13px}.search-form:focus-within{border-color:var(--accent)}.search-form button{border:0;background:transparent;color:var(--muted);font-size:19px;cursor:pointer;padding:3px 9px}.range-menu{position:relative}.range-menu summary{cursor:pointer;list-style:none;color:var(--fg);font-size:16px;font-weight:500;padding:4px 0;border-radius:4px}.range-menu summary::-webkit-details-marker{display:none}.range-menu summary span{font-size:13px;color:var(--muted);margin-left:4px}.range-menu summary:hover{color:var(--accent)}.range-options{position:absolute;top:100%;left:0;z-index:5;min-width:120px;padding:4px;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px #0002}.range-option{display:block;padding:6px 10px;text-decoration:none;font-size:13px;font-weight:400;white-space:nowrap;border-radius:6px}.range-option:hover,.range-option.active{background:var(--selected);color:var(--accent)}.main-head h2{font-size:23px;letter-spacing:-.03em;margin:0}.main-head p{color:var(--muted);margin:3px 0 0;font-size:12px}.head-actions{display:flex;gap:8px}.top-button{padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);text-decoration:none;white-space:nowrap}.filter-chip{display:inline-block;margin-left:5px;padding:2px 6px;border-radius:5px;background:var(--selected);color:var(--accent)}.review-navigation{padding:12px 0;border-bottom:1px solid var(--line)}.review-page{max-width:940px}.review-header h2{font-size:22px;margin:0 0 4px}.review-header p,.review-generate p,.review-meta,.review-hint{color:var(--muted);font-size:12px}.review-scope,.review-generate{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:18px 0}.review-scope label,.review-generate label{display:flex;align-items:center;gap:8px}.review-scope input,.review-scope select,.review-generate select,.review-scope button,.review-generate button,.review-actions button{font:inherit;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:7px 10px}.review-scope button,.review-generate button,.review-actions button{cursor:pointer}.review-generate button:disabled{opacity:.5;cursor:default}.review-generate p{flex-basis:100%;margin:0}.review-status{font-size:12px;color:var(--muted)}.review-section{margin:24px 0}.review-section h3{font-size:15px;margin:0 0 10px}.review-item{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px 18px;margin:8px 0}.review-project-group h4{font-size:12px;color:var(--accent);margin:14px 0 6px}.review-support{font-size:11px;color:var(--muted);margin-left:8px}.review-item p{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}.review-evidence{font-size:12px;color:var(--muted);margin-top:10px}.review-evidence summary{cursor:pointer}.evidence-item{margin-top:10px}.evidence-item pre{font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);color:var(--fg);padding:10px;border-radius:7px;max-height:320px;overflow:auto}.review-actions{display:flex;gap:8px;align-items:center;margin-top:10px;color:var(--muted);font-size:12px}.review-template-link{margin:20px 0;color:var(--accent)}.review-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:14px}.review-summary strong{font-size:12px;color:var(--muted)}.review-summary .meta{margin:8px 0 0}.cards{display:grid;gap:14px}.timeline-day{position:relative;padding-top:1px}.timeline-day::before{content:"";position:absolute;left:4px;top:31px;bottom:0;width:1px;background:var(--line)}.timeline-date{padding-left:4px;text-align:left;font-size:11px;font-weight:600;color:var(--muted);margin:12px 0}.timeline-row{display:grid;grid-template-columns:74px minmax(0,1fr) 36px;gap:8px;align-items:start;position:relative;margin:0 0 10px}.timeline-row::before{content:"";position:absolute;left:1px;top:19px;width:7px;height:7px;border-radius:50%;background:var(--muted);border:1px solid var(--bg)}.timeline-time{padding:15px 0 0 15px;text-align:left;font-size:11px;line-height:1.4;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}.timeline-actions{opacity:0;pointer-events:none}.timeline-row:hover .timeline-actions,.timeline-row:focus-within .timeline-actions,.timeline-actions[open]{opacity:1;pointer-events:auto}@media(hover:none){.timeline-actions{opacity:1;pointer-events:auto}}.timeline-actions summary{background:var(--panel);border:1px solid var(--line);text-align:center;padding:7px 4px;font-size:17px;line-height:1}.timeline-actions summary.is-favorite{color:var(--accent)}.timeline-actions .menu{top:100%;z-index:8}.timeline-actions .menu button{font-size:12px;line-height:1.5;padding:7px 10px;color:var(--fg)}.timeline-actions .menu button:hover{background:var(--selected)}.card-footer[hidden]{display:none}.card,.empty{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 2px 8px #00000007}.card{padding:12px 16px}.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}.card-head time{font-size:11px;line-height:1.2;color:var(--muted);opacity:.75;font-variant-numeric:tabular-nums}.actions{display:flex;align-items:center;gap:5px}.action,.more summary,.menu button,.tag-editor button{border:1px solid var(--line);background:transparent;color:var(--muted);padding:5px 10px;border-radius:7px;font:inherit;font-size:12px;cursor:pointer}.favorite{font-size:17px;line-height:1;color:var(--accent)}.more{position:relative}.more summary{list-style:none}.more summary::-webkit-details-marker{display:none}.menu{position:absolute;right:0;top:34px;z-index:3;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:4px;box-shadow:0 6px 24px #0002;min-width:105px}.menu button{display:block;border:0;width:100%;text-align:left;white-space:nowrap}.meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.meta>span{font-size:11px;color:var(--accent);background:var(--selected);padding:3px 8px;border-radius:6px}.card-footer{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;margin-top:12px}.card-tags{display:flex;flex-wrap:wrap;gap:6px}.card-tags .tag{display:inline-flex;align-items:center;padding:3px 8px;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:12px}.tag button{border:0;background:none;color:inherit;cursor:pointer;padding:0 0 0 3px}.prompt{font-size:15px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere}.prompt mark{background:#ffe280;color:#29220c;border-radius:2px;padding:0}.attachment-label{display:inline-flex;align-items:center;gap:4px;vertical-align:baseline;padding:1px 6px;border:1px solid var(--line);border-radius:5px;color:var(--muted);font-size:12px;line-height:1.5}.pictures{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.pictures[hidden]{display:none}.selection-copy{position:fixed;z-index:20;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--fg);box-shadow:0 4px 16px #0002;padding:5px 9px;font:inherit;font-size:12px;line-height:1.4;cursor:pointer;white-space:nowrap}.selection-copy[hidden]{display:none}.image-preview{border:0;padding:0;border-radius:10px;background:transparent;cursor:zoom-in}.image-preview:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.image-dialog{position:fixed;inset:0;max-width:100vw;max-height:100vh;width:100%;height:100%;margin:auto;padding:48px;border:0;background:transparent;overflow:auto}.image-dialog[open]{display:flex;align-items:center;justify-content:center}.image-dialog::backdrop{background:#000c}.image-dialog img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}.preview-prev,.preview-next{position:fixed;top:50%;transform:translateY(-50%);width:42px;height:48px;border:0;border-radius:8px;background:#222b;color:white;font-size:32px;line-height:1;cursor:pointer}.preview-prev{left:16px}.preview-next{right:16px}.preview-prev:disabled,.preview-next:disabled{opacity:.3;cursor:default}.preview-count{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:3px 10px;border-radius:12px;background:#222b;color:white;font-size:12px}.close-preview{position:fixed;right:24px;top:20px;width:36px;height:36px;border:0;border-radius:50%;background:#222b;color:white;font-size:26px;line-height:1;cursor:pointer}.pictures img{display:block;width:72px;height:72px;object-fit:cover;border-radius:10px;background:var(--bg)}.source{flex:1 1 auto;min-width:0;color:var(--muted);font-size:11px;text-align:right}.source[open]{flex-basis:100%;text-align:left}.source summary{cursor:pointer;text-align:right}.source pre{text-align:left}.source pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;color:var(--fg);background:var(--bg);padding:12px;border-radius:8px}.template-editor{margin-top:14px}.template-editor input,.template-editor textarea{display:block;width:100%;font:inherit;border:1px solid var(--line);border-radius:6px;padding:8px;background:var(--bg);color:var(--fg);margin-bottom:8px}.template-editor p{font-size:11px;color:var(--muted)}.template-editor button{font:inherit;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:7px;padding:5px 10px;cursor:pointer}.tag-editor{margin-top:12px}.tag-editor input{font:inherit;border:1px solid var(--line);border-radius:6px;padding:6px;max-width:160px;background:var(--bg);color:var(--fg)}.empty{text-align:center;color:var(--muted);padding:50px}.empty strong{color:var(--fg)}.load-more-sentinel,.cursor-expired{text-align:center;margin:20px;color:var(--muted);font-size:12px}.load-retry{margin-left:8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);padding:5px 10px;cursor:pointer}@media(max-width:700px){.shell{grid-template-columns:minmax(125px,155px) minmax(0,1fr);gap:16px;padding:16px 12px}.sidebar{top:12px;max-height:calc(100vh - 24px)}.stats{gap:3px}.stats strong{font-size:16px}.stats span{font-size:10px}.heat,.calendar-spacer{font-size:9px}.main-head{align-items:start}.main-head.timeline-head{padding-right:38px}.search-form{max-width:145px}.heading-row{flex-wrap:wrap;gap:3px}.main-head h2{font-size:18px}.card{padding:12px}.timeline-row{grid-template-columns:68px minmax(0,1fr) 32px;gap:6px}.timeline-date{font-size:10px}.timeline-time{font-size:10px}.pictures img{width:60px;height:60px}}:root[data-theme="dark"]{--bg:var(--magpie-bg,#171a17);--panel:var(--magpie-card,#202420);--fg:var(--magpie-fg,#edf1ed);--muted:var(--magpie-muted,#9aa69d);--line:var(--magpie-line,#343c35);--accent:var(--magpie-accent,#8dd4a8);--selected:var(--magpie-accent-soft,#293c30)}:root[data-theme="dark"] .heat.level-0{background:#313831;color:var(--muted)}@media(prefers-color-scheme:dark){:root:not([data-theme]){--bg:#171a17;--panel:#202420;--fg:#edf1ed;--muted:#9aa69d;--line:#343c35;--accent:#8dd4a8;--selected:#293c30}:root:not([data-theme]) .heat.level-0{background:#313831;color:var(--muted)}}
/* The dot's 1px border sits outside its box; shift it onto the timeline rule. */
.timeline-row::before{left:0}
`;
