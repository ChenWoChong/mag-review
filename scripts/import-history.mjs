import { parseArgs } from 'node:util';
import { importHistory } from './history-import.js';
import { directoryFor } from '../storage.js';

try {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, 'if-missing': { type: 'boolean' }, directory: { type: 'string' } } });
  const report = await importHistory(directoryFor(values), { apply: values.apply, ifMissing: values['if-missing'] });
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(`[prompt-diary] history import failed: ${error.message}`);
  process.exitCode = 1;
}
