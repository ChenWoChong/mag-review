import { withStore } from '../submissions.js';

export function writeRecords(directory, records, images = []) {
  return withStore(directory, db => {
    db.exec('DELETE FROM prompts; DELETE FROM images;');
    const insert = db.prepare('INSERT OR REPLACE INTO prompts VALUES (?, ?)');
    for (const { time, ...record } of records) insert.run(record.id, JSON.stringify({
      source: 'magpie', session: 'thread', submittedAt: new Date(time).toISOString(), attachments: [], ...record,
    }));
    for (const [id, bytes] of images) db.prepare('INSERT INTO images VALUES (?, ?)').run(id, bytes);
  });
}
