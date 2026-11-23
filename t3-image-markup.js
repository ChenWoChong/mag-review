// These markers describe images already attached to this submission. They
// never supply paths or IDs to the file reader.
export function prepareT3Images(text, attachments) {
  const byId = new Map(attachments.filter(item => item.mimeType.startsWith('image/')).map(item => [item.id, item]));
  if (!byId.size) return { text, byRef: new Map() };
  const byRef = new Map();
  for (const item of byId.values()) for (const ref of item.refs || []) byRef.set(ref, item);

  // Leave fenced examples and inline code untouched.
  const chunks = [];
  const code = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*(?=\r?$)|(`+)[^\n]*?\2(?!`)/gm;
  let offset = 0;
  for (const match of text.matchAll(code)) {
    chunks.push(text.slice(offset, match.index), match[0]);
    offset = match.index + match[0].length;
  }
  chunks.push(text.slice(offset));
  for (let i = 0; i < chunks.length; i += 2) {
    chunks[i] = chunks[i].replace(/^[ \t]*<t3_context version="1">[ \t]*\r?\n([\s\S]*?)^[ \t]*<\/t3_context>[ \t]*(?:\r?\n|$)/gm, (block, body) => {
      const matches = [...body.matchAll(/<context kind="image" id="([\w-]+)">\s*([^<>]*)<\/context>/g)];
      if (!matches.length || body.replace(/<context kind="image" id="[\w-]+">\s*[^<>]*<\/context>/g, '').trim()) return block;
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
      (line, id) => byId.has(id) ? '' : line);
  }

  return { text: chunks.join(''), byRef };
}
