const contextBlock = /^[ \t]*<t3_context version="1">[ \t]*\r?\n([\s\S]*?)^[ \t]*<\/t3_context>[ \t]*(?:\r?\n|$)/gm;
const imageContext = /<context kind="image" id="([\w-]+)">\s*([^<>]*)<\/context>/g;
const localImageNotice = /^[ \t]*\[Attached image "[^"\r\n]*" is saved at: [^\r\n\]]*[/.\\]\.t3[/\\]userdata[/\\]attachments[/\\][\w-]+\.(?:png|jpe?g|gif|webp)\][ \t]*(?:\r?\n|$)/gim;

function outsideCode(text, transform) {
  const chunks = [];
  const code = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*(?=\r?$)|(`+)[^\n]*?\2(?!`)/gm;
  let offset = 0;
  for (const match of text.matchAll(code)) {
    chunks.push(transform(text.slice(offset, match.index)), match[0]);
    offset = match.index + match[0].length;
  }
  chunks.push(transform(text.slice(offset)));
  return chunks.join('');
}

// The client carries image references and image bytes separately. The metadata
// can label previews already in this request, but never supplies image bytes.
export function normalizeGatewayImages(text, attachments) {
  const wrapped = [];
  const clean = outsideCode(text, chunk => chunk.replace(localImageNotice, '').replace(contextBlock, (block, body) => {
    const fields = [...body.matchAll(imageContext)];
    if (!fields.length || body.replace(imageContext, '').trim()) return block;
    const entries = fields.map(([, ref, metadata]) => ({
      ref,
      name: /^name: ([^\r\n]{1,255})\r?$/m.exec(metadata)?.[1],
      mimeType: /^mimeType: (image\/(?:png|jpeg|gif|webp))\r?$/m.exec(metadata)?.[1],
      hasSize: /^sizeBytes: \d+\r?$/m.test(metadata),
      hasId: /^attachmentId: [\w-]+\r?$/m.test(metadata),
    }));
    if (entries.some(entry => !entry.name || !entry.mimeType || !entry.hasSize || !entry.hasId)) return block;
    wrapped.push(...entries);
    return '';
  }));
  if (!wrapped.length) return { text: clean === text ? text : clean.trimEnd(), attachments };
  const bind = wrapped.length === attachments.length && new Set(wrapped.map(entry => entry.ref)).size === wrapped.length
    && wrapped.every((entry, i) => entry.mimeType === attachments[i].mimeType && !attachments[i].refs?.length);
  if (bind) {
    return { text: clean.trimEnd(), attachments: attachments.map((item, i) => ({ ...item, name: wrapped[i].name, refs: [wrapped[i].ref] })) };
  }
  const refs = new Set(wrapped.map(entry => entry.ref));
  const normalized = outsideCode(clean, chunk => chunk.replace(/\[Image: ([^\]\r\n]*); ref=([\w-]+)\]/g,
    (match, name, ref) => refs.has(ref) ? name : match));
  return { text: normalized.trimEnd(), attachments };
}

// These markers describe images already attached to this submission. They
// never supply paths or IDs to the file reader.
export function prepareT3Images(text, attachments) {
  const byId = new Map(attachments.filter(item => item.mimeType.startsWith('image/')).map(item => [item.id, item]));
  if (!byId.size) return { text, byRef: new Map() };
  const byRef = new Map();
  for (const item of byId.values()) for (const ref of item.refs || []) byRef.set(ref, item);

  // Leave fenced examples and inline code untouched.
  const clean = outsideCode(text, chunk => chunk.replace(contextBlock, (block, body) => {
    const matches = [...body.matchAll(imageContext)];
    if (!matches.length || body.replace(imageContext, '').trim()) return block;
    const entries = new Map();
    for (const [, ref, fields] of matches) {
      const id = /^attachmentId: ([\w-]+)\r?$/m.exec(fields)?.[1];
      const item = byId.get(id);
      const existing = entries.get(ref) || byRef.get(ref);
      if (!item || (existing && existing !== item)) return block;
      entries.set(ref, item);
    }
    for (const [ref, item] of entries) byRef.set(ref, item);
    return '';
  }).replace(/^[ \t]*\[Attached image "[^"\r\n]*" is saved at: [^\r\n\]]*\/userdata\/attachments\/([\w-]+)\.(?:png|jpe?g|gif|webp)\][ \t]*(?:\r?\n|$)/gim,
    (line, id) => byId.has(id) ? '' : line));

  return { text: clean, byRef };
}
