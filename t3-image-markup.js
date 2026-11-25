const contextEntry = /^<context kind="([a-z][a-z0-9-]{0,39})" id="([\w-]{1,128})"(?: unavailable="true"\s*\/>|>\r?\n([\s\S]*?)^<\/context>)[ \t]*(?:\r?\n|$)/gm;
const protectedText = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*(?=\r?$)|(?![\s\S]))|(`+)[^\n]*?\2(?!`)|^[ \t]*<t3_context version="1">[ \t]*\r?\n([\s\S]*?)^[ \t]*<\/t3_context>[ \t]*(?:\r?\n|$)|^[ \t]*<assistant_citations>[ \t]*\r?\n([\s\S]*?)^[ \t]*<\/assistant_citations>[ \t]*(?:\r?\n|$)/gm;
const imageMime = /^image\/(?:png|jpeg|gif|webp)$/;
const attachmentPath = /^[ \t]*\[Attached (image|file) "([^"\r\n]*)" is saved at: [^\r\n\]]*?[/\\](?:\.t3[/\\])?userdata[/\\]attachments[/\\]([\w-]{1,128})(?:\.[^ /\\\r\n\]]+)?(?: \(text extracted to: [^\r\n\]]*\))?\][ \t]*(?=\r?$)/gim;
const unavailableAttachment = /^[ \t]*\[Attached (image|file) "([^"\r\n]*)" is unavailable: could not resolve a saved path for attachment '([\w-]{1,128})'\.\][ \t]*(?=\r?$)/gim;

const providerReference = /\[([A-Z][a-z0-9]*(?: [a-z0-9]+)*): ([^[\];\r\n]+); ref=([\w-]{1,128})\]/g;
export const t3ProviderReference = new RegExp(`^${providerReference.source}`);
export const t3ContextHref = /^t3-context:\/\/v1\/([a-z][a-z0-9-]{0,39})\/([\w-]{1,128})$/;

const quoteMarker = /\[(assistant-quote-\d+)\]/g;

function mapText(text, plain, envelope = block => block, citationEnvelope = block => block) {
  const chunks = [];
  let offset = 0;
  for (const match of text.matchAll(protectedText)) {
    chunks.push(plain(text.slice(offset, match.index)));
    if (match[3] !== undefined) chunks.push(envelope(match[0], match[3]));
    else if (match[4] !== undefined) chunks.push(citationEnvelope(match[0], match[4]));
    else chunks.push(match[0]);
    offset = match.index + match[0].length;
  }
  chunks.push(plain(text.slice(offset)));
  return chunks.join('');
}

function entriesIn(body) {
  const entries = [...body.matchAll(contextEntry)];
  if (!entries.length || body.replace(contextEntry, '').trim()) return [];
  return entries.map(([, kind, ref, metadata]) => ({ kind, ref, metadata: metadata ?? '' }));
}

// Bind image metadata only to validated bytes already associated with this card.
export function normalizeGatewayAttachments(text, attachments) {
  if (!text.includes('<t3_context') && !text.includes('[Attached ') && !text.includes('<assistant_citations>')) return { text, attachments };
  const attachmentById = new Map(attachments.map(item => [item.id, item]));
  const referenced = new Set();
  mapText(text, chunk => {
    for (const [, kind, , ref] of chunk.matchAll(providerReference)) {
      referenced.add(`${kind.toLowerCase().replaceAll(' ', '-')}/${ref}`);
    }
    for (const [, kind, ref] of chunk.matchAll(/\]\(t3-context:\/\/v1\/([a-z][a-z0-9-]{0,39})\/([\w-]{1,128})\)/g)) referenced.add(`${kind}/${ref}`);
    for (const [, ref] of chunk.matchAll(quoteMarker)) referenced.add(`quote/${ref}`);
    return chunk;
  });
  const quotes = new Map();
  const comments = [];
  const attachmentIds = new Set();
  const images = [];
  const clean = mapText(text, chunk => chunk, (block, body) => {
    const entries = entriesIn(body);
    if (!entries.length) return block;
    const details = entries.map(({ kind, ref, metadata }) => ({
      kind, ref,
      name: /^name: ([^\r\n]{1,255})\r?$/m.exec(metadata)?.[1],
      mimeType: /^mimeType: ([\w.+-]+\/[\w.+-]+)\r?$/m.exec(metadata)?.[1],
      hasSize: /^sizeBytes: \d+\r?$/m.test(metadata),
      attachmentId: /^attachmentId: ([\w-]{1,128})\r?$/m.exec(metadata)?.[1],
    }));
    const knownImage = entry => entry.kind === 'image' && entry.name
      && entry.attachmentId && (attachmentById.has(entry.attachmentId) || (entry.hasSize && imageMime.test(entry.mimeType)));
    if (details.some(entry => !referenced.has(`${entry.kind}/${entry.ref}`) && !knownImage(entry))) return block;
    for (const { kind, metadata } of entries) {
      if (kind === 'preview-annotation') {
        const comment = /^comment: ([\s\S]*?)(?=\r?\n(?:targets:|requested visual changes:|screenshot:|element \d+:)|(?![\s\S]))/m.exec(metadata)?.[1];
        if (comment) comments.push(comment);
      } else if (kind === 'review-comment') {
        const comment = /^comment:\r?\n((?:^  [^\r\n]*(?:\r?\n|$))+)/m.exec(metadata)?.[1];
        if (comment) comments.push(comment.replace(/^  /gm, '').trimEnd());
      }
    }
    for (const entry of details) {
      if ((entry.kind === 'image' || entry.kind === 'file') && entry.attachmentId) attachmentIds.add(`${entry.kind}/${entry.attachmentId}`);
      if (knownImage(entry)) images.push(entry);
    }
    return '';
  }, (block, body) => {
    if (!/^The following (?:citations refer to earlier assistant responses|excerpts were selected from earlier assistant responses)\./.test(body)) return block;
    let entries;
    try { entries = JSON.parse(body.slice(body.indexOf('\n') + 1)); }
    catch { return block; }
    if (!Array.isArray(entries) || !entries.length || entries.some(entry => !referenced.has(`quote/${entry?.id}`)
      || !/^assistant-quote-\d+$/.test(entry.id) || typeof entry.citation?.text !== 'string'
      || (entry.citation.comment !== undefined && typeof entry.citation.comment !== 'string'))) return block;
    for (const { id, citation } of entries) quotes.set(id, citation.comment?.trim() || '');
    return '';
  });
  const bindInOrder = images.length > 0 && images.length === attachments.length && new Set(images.map(entry => entry.ref)).size === images.length
    && images.every((entry, i) => entry.mimeType === attachments[i].mimeType && !attachmentById.has(entry.attachmentId) && !attachments[i].refs?.length);
  const notice = (_line, kind, label, id) => {
    const type = kind.toLowerCase();
    if (attachmentIds.has(`${type}/${id}`) || (type === 'image' && attachments.length > 0)) return '';
    const name = label.replace(/[[\];]/g, ' ').trim() || type;
    return `[${type === 'image' ? 'Image' : 'File'}: ${name}; ref=${id}]`;
  };
  const normalized = mapText(clean, chunk => chunk.replace(attachmentPath, notice).replace(unavailableAttachment, notice)
    .replace(quoteMarker, (marker, id) => {
      const comment = quotes.get(id);
      if (comment === undefined) return marker;
      quotes.set(id, '');
      return `[Assistant quote: 引用回复; ref=${id}]${comment ? ` ${comment}` : ''}`;
    }));
  const imageById = new Map(images.map(entry => [entry.attachmentId, entry]));
  return {
    text: comments.length ? [normalized.trimEnd(), ...comments].join('\n\n') : normalized === text ? text : normalized.trimEnd(),
    attachments: attachments.map((item, i) => {
      const image = bindInOrder ? images[i] : imageById.get(item.id);
      return image && imageMime.test(item.mimeType) ? { ...item, name: image.name, refs: [...new Set([...(item.refs || []), image.ref])] } : item;
    }),
  };
}
