import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceMessages, matchMessages } from '../history-import.js';

test('imports only authenticated user transcript messages with original time', () => {
  const user = (text, time, id) => JSON.stringify({ timestamp: time, type: 'response_item', payload: { type: 'message', role: 'user', id, content: [{ type: 'input_text', text }] } });
  const time = '2026-01-02T03:04:05Z';
  const source = sourceMessages('codex', [user('真实提问', time, '1'), user('环境说明', time, '2'), user('真实提问', time, '3')].join('\n'));
  const transcript = { parts: [{ role: 'user', kind: 'text', text: '真实提问' }, { role: 'user', kind: 'text', text: '真实提问' }, { role: 'user', kind: 'context', text: '环境说明' }] };
  const entries = matchMessages({ agent: 'codex', id: 'session', cwd: '/work' }, transcript, source);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].time, '2026-01-02T03:04:05.000Z');
  assert.notEqual(entries[0].id, entries[1].id);
});

test('only imports the active Pi branch', () => {
  const time = '2026-01-02T03:04:05Z';
  const row = (id, parentId, text) => JSON.stringify({ type: 'message', id, parentId, timestamp: time, message: { role: 'user', content: [{ type: 'text', text }] } });
  const result = sourceMessages('pi', [row('one', null, 'first'), row('old', 'one', 'old branch'), row('new', 'one', 'current branch')].join('\n'));
  assert.deepEqual(result.map(x => x.text), ['first', 'current branch']);
});
