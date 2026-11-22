import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPageService } from '../index.js';

test('retries a busy port until the page service starts', async () => {
  let calls = 0;
  let finished;
  const started = new Promise((resolve) => { finished = resolve; });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await startPageService({}, async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
      finished();
    }, 5);
    await started;
    assert.equal(calls, 3);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('does not hide unrelated startup failures', async () => {
  await assert.rejects(startPageService({}, async () => { throw new Error('invalid config'); }), /invalid config/);
});
