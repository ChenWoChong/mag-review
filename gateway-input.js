import { digest } from './submissions.js';
import { imageMime } from './diary.js';

const maxImage = 5 * 1024 * 1024;
const maxHistory = 4096;
const maxRequest = 24 * 1024 * 1024;
const contextEnvelope = /^\s*(?:<environment_context>[\s\S]*<\/environment_context>\s*$|<user_instructions>[\s\S]*<\/user_instructions>\s*$|# AGENTS\.md instructions for )/;
const supported = new Set(['chat', 'responses', 'anthropic', 'gemini']);
const automaticKinds = new Set([
  'guardian', 'auto_review', 'guardian_review', 'review', 'compact', 'compaction', 'memory', 'memgen', 'memory_consolidation',
  'thread_title', 'thread_title_reconsideration', 'title_generation', 'title', 'thread_description', 'composer_predictions',
  'subagent', 'collab_spawn', 'thread_spawn', 'agent_job', 'ambient_suggestions', 'ambient_suggestion_safety', 'routing', 'vision', 'web_search',
]);

function boundedString(value) {
  return typeof value === 'string' && value.length <= 512 && value.trim() ? value : null;
}

function protocolItems(body, protocol) {
  if (protocol === 'responses') {
    if (typeof body.input === 'string') return [{ role: 'user', content: body.input }];
    return body.input;
  }
  return protocol === 'gemini' ? body.contents : body.messages;
}

function contentOf(item, protocol) {
  const { role, type } = item;
  if (role !== 'user' || (protocol === 'responses' && type && type !== 'message')) return [];
  const content = protocol === 'gemini' ? item.parts : item.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
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

function isContextPart(part) {
  return typeof part?.text === 'string' && contextEnvelope.test(part.text);
}

function candidate(item, protocol, position, agent) {
  const parts = contentOf(item, protocol).filter(part => !isContextPart(part));
  const text = parts.filter(part => typeof part?.text === 'string' && (part.type === undefined || part.type === 'text' || part.type === 'input_text') && !part.thought)
    .map(part => part.text).join('\n');
  // These client-specific envelopes are ambiguous without separate input provenance.
  if (agent === 'pi' && /^\s*(?:\[pi-lens automated check — not a user request\] (?:Address .*blockers|Historical finding)|Context handoff \(full_thread_summary\):\s*Provider context handoff\.)/.test(text)) return null;
  if (/^\s*<task-notification>/.test(text)) return null;
  if (['codex', 't3code'].includes(agent) && /^Generate a title that will help the user recognize this T3 Code thread\b/.test(text)) return null;
  if (text.length > 200000 || parts.length > 64) return null;
  const images = new Map();
  for (const part of parts) {
    if (!part || images.size >= 8) continue;
    const image = imageOf(part);
    if (image) images.set(image.id, image);
  }
  if (!text.trim() && !images.size) return null;
  return { id: boundedString(item.id), position, text, images: [...images.values()] };
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
  if (!supported.has(protocol) || (origin !== 'local' && !(origin === 'magpie-key' && ctx.options?.captureManagedKeys === true))) return null;
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
  const input = protocolItems(body, protocol);
  if (!Array.isArray(input)) return { event, classify: () => ({ result: 'unsupported_input', items: [] }) };
  if (input.length > maxHistory || input.some(item => !item || typeof item !== 'object')) return { event, classify: () => ({ result: 'input_limit', items: [] }) };
  const compare = input.filter(item => {
    if (['system', 'developer'].includes(item.role)) return false;
    const parts = contentOf(item, protocol);
    return !parts.length || !parts.every(isContextPart);
  });
  let size = 0;
  const history = [];
  for (const item of compare) {
    const encoded = JSON.stringify(item);
    size += encoded.length;
    if (size > maxRequest) return { event, classify: () => ({ result: 'input_limit', items: [] }) };
    history.push(digest(encoded));
  }
  const previousResponse = protocol === 'responses' ? boundedString(body.previous_response_id) : null;
  const conversation = protocol === 'responses' ? boundedString(body.conversation?.id || body.conversation) : null;
  const continued = Boolean(previousResponse || conversation);
  if (scope) event.signature = digest(JSON.stringify([previousResponse, conversation, history]));
  return { event, classify(prior, seen) {
    let base = [];
    if (prior) {
      try { base = JSON.parse(prior.history); }
      catch (error) { throw new Error('Invalid saved gateway history', { cause: error }); }
    }
    const prefix = Boolean(prior && base.length < history.length && base.every((key, i) => history[i] === key));
    const confirmedDelta = previousResponse && compare.length === 1 && compare[0].role === 'user';
    const firstInput = !prior && compare.length === 1 && compare[0].role === 'user';
    const boundary = !seen && (confirmedDelta || (!continued && (firstInput || prefix)));
    const start = continued || !prior ? 0 : base.length;
    const items = [];
    for (const [position, item] of compare.entries()) {
      const identified = scope && item.role === 'user' && boundedString(item.id);
      const single = compare.length === 1;
      const hasNewId = identified && !seen && (previousResponse || (!continued && prior && single));
      const isNew = (boundary && position >= start) || hasNewId;
      if (!isNew && !identified) continue;
      if (!isNew) {
        items.push({ item: { id: identified }, existingOnly: true });
        continue;
      }
      const found = candidate(item, protocol, position, agent);
      if (found) items.push({ item: found, evidence: identified ? 'message_id' : 'gateway_boundary' });
    }
    const matched = items.some(item => !item.existingOnly);
    const result = matched ? 'matched_input' : seen ? 'replayed_or_ambiguous' : 'no_confirmed_input';
    // Use the first observation as a baseline. After that, keep the last
    // confirmed input boundary so a tool-only suffix can be omitted later.
    const updateHistory = !continued && history.length && (!prior || (prefix && matched));
    return { result, items, history: updateHistory ? history : null };
  } };
}
