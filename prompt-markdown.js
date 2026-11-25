import MarkdownIt from 'markdown-it';
import { t3ContextHref, t3ProviderReference } from './t3-image-markup.js';

const markdown = new MarkdownIt({ breaks: true, html: false });
const { escapeHtml } = markdown.utils;

export function highlightText(text, query) {
  if (!query) return escapeHtml(text);
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  let result = '', start = 0;
  for (const match of text.matchAll(pattern)) {
    result += escapeHtml(text.slice(start, match.index)) + `<mark>${escapeHtml(match[0])}</mark>`;
    start = match.index + match[0].length;
  }
  return result + escapeHtml(text.slice(start));
}

markdown.renderer.rules.text = (tokens, index, _options, env) => highlightText(tokens[index].content, env.query);
markdown.renderer.rules.code_inline = (tokens, index, _options, env) => `<code>${highlightText(tokens[index].content, env.query)}</code>`;
markdown.renderer.rules.code_block = (tokens, index, _options, env) => `<pre><code>${highlightText(tokens[index].content, env.query)}</code></pre>\n`;
const renderFence = markdown.renderer.rules.fence;
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => renderFence(tokens, index, {
  ...options,
  highlight: content => highlightText(content, env.query),
}, env, renderer);

// Only a card's stored images can open a preview. Other Markdown images use alt text.
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const reference = t3ContextHref.exec(token.attrGet('src'));
  const label = renderer.renderInlineAsText(token.children, options, env);
  if (reference) return renderReference(reference[1], reference[2], label, env);
  return highlightText(label, env.query);
};

function renderReference(kind, ref, label, env) {
  return env.attachmentForRef?.(kind, ref, label) || `<span class="attachment-label">${highlightText(label, env.query)}</span>`;
}

markdown.inline.ruler.before('link', 't3_reference', (state, silent) => {
  const first = state.src[state.pos];
  if (first !== '[' && first !== '!') return false;
  const source = state.src.slice(state.pos, state.posMax);
  const marker = t3ProviderReference.exec(source);
  const link = marker ? null : /^!?\[([^\[\]\r\n]+)\]\((t3-(?:context|thread|citation):\/\/[^)\s]+)\)/.exec(source);
  const href = link && t3ContextHref.exec(link[2]);
  const otherLink = link && /^t3-(thread|citation):\/\/v[12]\/[\w%?&=./+~-]+$/.exec(link[2]);
  if (!marker && !href && !otherLink) return false;
  if (!silent) {
    const token = state.push('t3_reference', '', 0);
    if (marker) token.meta = { kind: marker[1].toLowerCase().replaceAll(' ', '-'), ref: marker[3], label: marker[2] };
    else token.meta = { kind: (href ?? otherLink)[1], ref: href?.[2], label: link[1] };
  }
  state.pos += (marker ?? link)[0].length;
  return true;
});
markdown.renderer.rules.t3_reference = (tokens, index, _options, env) => {
  const { kind, ref, label } = tokens[index].meta;
  return renderReference(kind, ref, label, env);
};

export function renderMarkdown(text, env = {}) {
  return markdown.render(text, env);
}
