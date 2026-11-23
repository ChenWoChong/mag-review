import { resolve } from 'node:path';
import { verifyStore } from '../submissions.js';
import { directoryFor } from '../storage.js';

const directory = process.argv[2] ? resolve(process.argv[2]) : directoryFor({});
const result = verifyStore(directory);
console.log(JSON.stringify(result, null, 2));
if (result.integrity !== 'ok' || result.missingCapture || result.foreignKeyErrors) process.exitCode = 1;
