import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function directoryFor(options) {
  return resolve(typeof options?.directory === 'string' && options.directory.trim()
    ? options.directory : join(homedir(), '.local', 'share', 'magpie-prompt-diary'));
}
