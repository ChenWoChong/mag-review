import MarkdownIt from 'markdown-it';

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

// Resolve T3 images only through the current card. Other Markdown images show
// their alt text without causing network requests or opening local files.
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const src = token.attrGet('src');
  const ref = /^t3-context:\/\/v1\/image\/([\w-]+)$/.exec(src)?.[1];
  if (ref && env.imageForRef) {
    const image = env.imageForRef(ref);
    if (image) return image;
  }
  return highlightText(renderer.renderInlineAsText(token.children, options, env), env.query);
};

markdown.inline.ruler.before('link', 't3_image_ref', (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x5b || !state.env.imageForRef) return false;
  const match = /^\[Image: [^\]\r\n]*; ref=([\w-]+)\]/.exec(state.src.slice(state.pos, state.posMax));
  if (!match) return false;
  if (!silent) state.push('t3_image_ref', '', 0).meta = { ref: match[1], raw: match[0] };
  state.pos += match[0].length;
  return true;
});
markdown.renderer.rules.t3_image_ref = (tokens, index, _options, env) => {
  const { ref, raw } = tokens[index].meta;
  return env.imageForRef(ref) || highlightText(raw, env.query);
};

export function renderMarkdown(text, env = {}) {
  return markdown.render(text, env);
}
