import { createHash } from 'node:crypto';
export function hashText(text) { return createHash('sha256').update(text).digest('hex'); }
export function eventKey(session, event) {
  return hashText(JSON.stringify([session, event.event || '', event.time]));
}
