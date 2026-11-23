import { isAbsolute, resolve } from 'node:path';
import { readSubmissions } from '../submissions.js';
import { readT3Submissions } from '../t3-submissions.js';
import { directoryFor } from '../storage.js';

const [t3DataDirectory, directory] = process.argv.slice(2);
if (!t3DataDirectory || !isAbsolute(t3DataDirectory)) {
  console.error('用法：npm run verify-history -- /绝对路径/.t3 [日记目录]');
  process.exitCode = 1;
} else {
  const expected = await readT3Submissions(t3DataDirectory);
  const actual = await readSubmissions(directory ? resolve(directory) : directoryFor({}));
  const expectedById = new Map(expected.map(row => [row.id, row]));
  const actualById = new Map(actual.map(row => [row.id, row]));
  const missing = expected.filter(row => !actualById.has(row.id)).length;
  const unexpected = actual.filter(row => !expectedById.has(row.id)).length;
  const mismatch = expected.filter(row => actualById.has(row.id) && JSON.stringify(row) !== JSON.stringify(actualById.get(row.id))).length;
  const duplicateIds = actual.length - actualById.size;
  console.log(JSON.stringify({ expected: expected.length, recorded: actual.length, missing, unexpected, mismatch, duplicateIds }, null, 2));
  if (missing || unexpected || mismatch || duplicateIds) process.exitCode = 1;
}
