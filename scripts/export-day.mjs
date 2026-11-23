import { resolve } from 'node:path';
import { readSubmissions } from '../submissions.js';
import { localDate, localTime } from '../records.js';
import { directoryFor } from '../storage.js';

const [day, directory] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || localDate(`${day}T12:00:00`) !== day) {
  console.error('用法：npm run --silent export-day -- YYYY-MM-DD [日记目录]');
  process.exitCode = 1;
} else {
  const records = await readSubmissions(directory ? resolve(directory) : directoryFor({}));
  console.log(`# Prompt 日记 · ${day}`);
  for (const record of records.filter(row => localDate(row.submittedAt) === day)) {
    let fenceLength = 3;
    for (const match of record.text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    console.log(`\n## ${localTime(record.submittedAt)} · ${record.agent || '未知 Agent'}`);
    if (record.text) console.log(`\n${fence}text\n${record.text}\n${fence}`);
    if (record.attachments.length) console.log(`\n附件 ${record.attachments.map(attachment => attachment.name.replace(/[\r\n]/g, ' ')).join('、')}`);
  }
}
