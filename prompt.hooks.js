import { directoryFor } from './storage.js';
import { captureRequest } from './submissions.js';
import { prepareCapture } from './gateway-input.js';

export function onRequest(body, ctx) {
  if (ctx.signal?.aborted) return;
  const capture = prepareCapture(body, ctx);
  if (!capture || ctx.signal?.aborted) return;
  const result = captureRequest(directoryFor(ctx.options), capture.event, capture.classify);
  ctx.report?.(result === 'matched_input' ? 'ready' : 'empty');
}
