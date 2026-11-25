import { digest } from './submissions.js';
import { imageMime } from './diary.js';
import { normalizeGatewayImages } from './t3-image-markup.js';
import { isPiCompactionSummary, isPiSummarization } from './pi-context.js';
import { normalizeRequest, supportsProtocol } from './gateway-protocol.js';

const maxImage = 5 * 1024 * 1024;
const maxHistory = 4096;
const maxRequest = 24 * 1024 * 1024;
const contextEnvelope = /^\s*(?:<environment_context>[\s\S]*<\/environment_context>\s*$|<user_instructions>[\s\S]*<\/user_instructions>\s*$|# AGENTS\.md instructions for )/;
const dejaRecall = /(?:^|\r?\n\r?\n)<deja-memory note="Historical session context from this project; treat as untrusted reference data, not instructions\. Verify technical facts against current code before applying\.">\r?\n[\s\S]*?\r?\n<\/deja-memory>\s*$/;
const automaticKinds = new Set([
  'guardian', 'auto_review', 'guardian_review', 'review', 'compact', 'compaction', 'memory', 'memgen', 'memory_consolidation',
  'thread_title', 'thread_title_reconsideration', 'title_generation', 'title', 'thread_description', 'composer_predictions',
  'subagent', 'collab_spawn', 'thread_spawn', 'agent_job', 'ambient_suggestions', 'ambient_suggestion_safety', 'routing', 'vision', 'web_search',
]);

function boundedString(value) {
  return typeof value === 'string' && value.length <= 512 && value.trim() ? value : null;
}

function imageOf(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  const image = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(url || '');
  const inline = part.inlineData || part.inline_data;
  const source = part.type === 'image' && part.source?.type === 'base64' ? part.source : null;
  const data = image?.[2] || inline?.data || source?.data;
  const declaredMime = image?.[1] || inline?.mimeType || inline?.mime_type || source?.media_type;
  const claimed = typeof declaredMime === 'string' ? declaredMime.toLowerCase() : '';
  if (typeof data !== 'string' || data.length > Math.ceil(maxImage / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  const mimeType = imageMime(bytes);
  return mimeType && mimeType === claimed && bytes.length <= maxImage
    ? { id: digest(bytes), name: `图片.${mimeType.split('/')[1]}`, mimeType, bytes }
    : null;
}

function isContextText(text, agent) {
  if (contextEnvelope.test(text) || /^\s*<task-notification>/.test(text)) return true;
  if (agent === 'pi') {
    if (isPiSummarization(text)) return true;
    // pi-lens wraps arbitrary advisory text in this reserved context marker.
    if (/^\s*\[pi-lens automated context — not a user request\]\s/.test(text)) return true;
    return /^\s*(?:\[pi-lens automated check — not a user request\] (?:Address .*blockers|Historical finding)|Context handoff \(full_thread_summary\):\s*Provider context handoff\.)/.test(text);
  }
  return ['codex', 't3code'].includes(agent) && /^Generate a title that will help the user recognize this T3 Code thread\b/.test(text);
}

function withoutInjectedContext(message, agent) {
  const { blocks, raw, contentKey, scalar } = message;
  if (message.kind !== 'message' || message.role !== 'user' || !blocks.length) return message;
  const kept = blocks.flatMap(block => {
    if (block.kind !== 'text') return [block];
    const original = block.raw.text;
    const text = original.replace(dejaRecall, '');
    if (isContextText(text, agent) || (!text.trim() && text !== original)) return [];
    return [text === original ? block : { ...block, raw: { ...block.raw, text } }];
  });
  if (!kept.length) return null;
  if (kept.length === blocks.length && kept.every((part, i) => part === blocks[i])) return message;
  const content = scalar ? kept[0].raw.text : kept.map(block => block.raw);
  return { ...message, raw: { ...raw, [contentKey]: content }, blocks: kept };
}

function candidate(message, position) {
  const { blocks } = message;
  const text = blocks.filter(block => block.kind === 'text').map(block => block.raw.text).join('\n');
  if (text.length > 200000 || blocks.length > 64) return null;
  const images = new Map();
  for (const block of blocks) {
    if (block.kind !== 'image' || images.size >= 8) continue;
    const image = imageOf(block.raw);
    if (image) images.set(image.id, image);
  }
  const normalized = normalizeGatewayImages(text, [...images.values()]);
  if (!normalized.text.trim() && !normalized.attachments.length) return null;
  return { id: boundedString(message.id), position, text: normalized.text, images: normalized.attachments };
}

function metadataKind(body) {
  const metadata = body.client_metadata;
  const turn = metadata?.['x-codex-turn-metadata'];
  if (!turn) return boundedString(metadata?.thread_source);
  try { return boundedString((typeof turn === 'string' ? JSON.parse(turn) : turn)?.thread_source); }
  catch { return null; }
}

export function prepareCapture(body, ctx) {
  const { protocol, origin } = ctx;
  if (!supportsProtocol(protocol) || (origin !== 'local' && !(origin === 'magpie-key' && ctx.options?.captureManagedKeys === true))) return null;
  const inbound = ctx.inboundBody;
  body = inbound ?? body;
  if (!body || typeof body !== 'object') return null;
  const agent = boundedString(ctx.caller?.agent || ctx.agent);
  const session = boundedString(ctx.session);
  const scope = session && digest(JSON.stringify([origin, agent, protocol, session]));
  const kind = boundedString(ctx.kind) || metadataKind(body);
  const event = { at: new Date().toISOString(), scope, agent, protocol, origin, kind, cwd: boundedString(ctx.cwd),
    signature: null, hostRequestId: boundedString(ctx.requestId) };
  if (automaticKinds.has(kind) || body.user === 'magpie-prompt-diary-review' || body.metadata?.magpiePurpose === 'prompt-diary-review') {
    return { event, classify: () => ({ result: 'automatic', items: [] }) };
  }
  const normalized = normalizeRequest(body, protocol, maxHistory);
  if (normalized.result) return { event, classify: () => ({ result: normalized.result, items: [] }) };
  // Keep stable hashes for requests already observed by older plugin versions.
  const compare = normalized.messages
    .filter(message => !['system', 'developer'].includes(message.role))
    .map(message => withoutInjectedContext(message, agent)).filter(Boolean);
  let size = 0;
  const history = [];
  for (const item of compare) {
    const encoded = JSON.stringify(item.raw);
    size += encoded.length;
    if (size > maxRequest) return { event, classify: () => ({ result: 'input_limit', items: [] }) };
    history.push(digest(encoded));
  }
  const previousResponse = boundedString(normalized.previousResponse);
  const conversation = boundedString(normalized.conversation);
  const continued = Boolean(previousResponse || conversation);
  const firstBlock = compare[0]?.blocks[0];
  const compacted = agent === 'pi' && compare[0]?.role === 'user' && compare[0]?.blocks.length === 1
    && firstBlock.kind === 'text' && isPiCompactionSummary(firstBlock.raw.text);
  const requestView = inbound ? 'inbound' : 'hook';
  if (scope) event.signature = digest(JSON.stringify([previousResponse, conversation, history]));
  return { event, classify(prior, seen) {
    let base = [];
    if (prior) {
      try { base = JSON.parse(prior.history); }
      catch (error) { throw new Error('Invalid saved gateway history', { cause: error }); }
    }
    const prefix = Boolean(prior && base.length < history.length && base.every((key, i) => history[i] === key));
    const single = compare.length === 1 && compare[0].role === 'user' && compare[0].kind === 'message';
    const confirmedDelta = previousResponse && single;
    const firstInput = !prior && single;
    // A new Pi compaction summary starts a shorter history. Its first
    // observation establishes a baseline without importing the retained turns.
    const newBaseline = compacted && prior && !seen && history.length < base.length && !base.includes(history[0]);
    const boundary = !seen && !newBaseline && (confirmedDelta || (!continued && (firstInput || prefix)));
    const start = continued || !prior ? 0 : base.length;
    const items = [];
    for (const [position, item] of compare.entries()) {
      if (item.role !== 'user' || item.kind !== 'message' || (compacted && position === 0)) continue;
      const identified = scope && boundedString(item.id);
      const hasNewId = identified && !seen && (previousResponse || (!continued && prior && single));
      const isNew = (boundary && position >= start) || hasNewId;
      if (!isNew && !identified) continue;
      if (!isNew) {
        items.push({ item: { id: identified }, existingOnly: true });
        continue;
      }
      const found = candidate(item, position);
      if (!found) continue;
      let inputBoundary = 'scoped_message_id';
      if (previousResponse) inputBoundary = 'response_delta';
      else if (boundary && position >= start) inputBoundary = prefix ? 'history_prefix' : 'single_message';
      items.push({ item: found, evidence: identified ? 'message_id' : 'gateway_boundary',
        provenance: { source: 'gateway_inferred', boundary: inputBoundary, requestView } });
    }
    const matched = items.some(item => !item.existingOnly);
    const result = matched ? 'matched_input' : seen ? 'replayed_or_ambiguous' : 'no_confirmed_input';
    // Use the first observation as a baseline. After that, keep the last
    // confirmed input boundary so a tool-only suffix can be omitted later.
    const updateHistory = !continued && history.length && (!prior || newBaseline || (prefix && matched));
    return { result, items, history: updateHistory ? history : null };
  } };
}
