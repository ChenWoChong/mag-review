// Preserve the protocol's item order and raw shape for existing history hashes.
const formats = {
  chat: { input: 'messages', content: 'content', text: ['text'], image: ['image_url'] },
  responses: { input: 'input', content: 'content', text: ['input_text', 'text'], image: ['input_image', 'image_url'] },
  anthropic: { input: 'messages', content: 'content', text: ['text'], image: ['image'] },
  gemini: { input: 'contents', content: 'parts', text: [], image: [] },
};

function blockKind(part, format) {
  if (!part || typeof part !== 'object') return 'unknown';
  if (part.type === 'tool_result' || part.functionResponse || part.function_response) return 'tool_result';
  if (part.type === 'tool_use' || part.functionCall || part.function_call) return 'tool_call';
  if (part.thought || ['thinking', 'redacted_thinking'].includes(part.type)) return 'reasoning';
  if (part.inlineData || part.inline_data) return 'image';
  if (format.image.includes(part.type)) {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    return part.source?.type === 'base64' || url?.startsWith?.('data:') ? 'image' : 'image_reference';
  }
  if (part.fileData || part.file_data || ['input_file', 'document', 'file'].includes(part.type)) return 'file';
  if (typeof part.text === 'string' && (part.type === undefined || format.text.includes(part.type))) return 'text';
  return 'unknown';
}

function itemKind(item, protocol) {
  if (protocol !== 'responses' || !item.type || item.type === 'message') return item.role ? 'message' : 'unknown';
  if (/_call_output$/.test(item.type)) return 'tool_result';
  if (/_call$/.test(item.type)) return 'tool_call';
  if (item.type === 'reasoning') return 'reasoning';
  return 'unknown';
}

export function supportsProtocol(protocol) {
  return Object.hasOwn(formats, protocol);
}

export function normalizeRequest(body, protocol, maxItems) {
  const format = formats[protocol];
  const input = body[format.input];
  const items = protocol === 'responses' && typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  if (!Array.isArray(items)) return { result: 'unsupported_input' };
  if (items.length > maxItems || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return { result: 'input_limit' };
  const messages = items.map((raw, position) => {
    const kind = itemKind(raw, protocol);
    const content = raw[format.content];
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    return {
      raw, position, kind, role: raw.role === 'model' && protocol === 'gemini' ? 'assistant' : raw.role,
      id: raw.id, contentKey: format.content, scalar: typeof content === 'string',
      blocks: parts.map((part, index) => ({ raw: part, index, kind: blockKind(part, format) })),
    };
  });
  return { messages, previousResponse: protocol === 'responses' ? body.previous_response_id : null,
    conversation: protocol === 'responses' ? body.conversation?.id || body.conversation : null };
}
