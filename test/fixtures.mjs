import { writeSubmissions } from '../submissions.js';

export function writeRecords(directory, records) {
  return writeSubmissions(directory, records.map(({ time, ...record }) => ({
    source: 't3code',
    session: 'thread',
    submittedAt: new Date(time).toISOString(),
    attachments: [],
    ...record,
  })));
}
