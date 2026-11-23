import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { submission } from './submissions.js';

const exec = promisify(execFile);
const agentAliases = new Map([['claudeAgent', 'claude'], ['magpie-codex', 'codex']]);

// T3's CLI transcript drops message IDs and author metadata. Keep the
// read-only projection schema isolated here until T3 exposes those fields.
const query = `
  SELECT m.message_id AS messageId, m.thread_id AS session, m.created_at AS submittedAt,
         json_extract(m.payload_json, '$.text') AS text,
         json_extract(m.payload_json, '$.attachments') AS attachments,
         json_extract(m.payload_json, '$.context') AS context,
         CASE WHEN json_extract(r.payload_json, '$.workspacePreparation.type') = 'root'
              THEN pr.workspace_root
              ELSE coalesce(json_extract(t.payload_json, '$.worktreePath'), pr.workspace_root)
         END AS cwd,
         pr.workspace_root AS projectRoot,
         coalesce(p.driver, r.provider) AS agent
  FROM orchestration_v2_projection_messages m
  JOIN orchestration_v2_projection_threads t ON m.thread_id = t.thread_id
  LEFT JOIN projection_projects pr ON t.project_id = pr.project_id
  LEFT JOIN orchestration_v2_projection_runs r ON m.run_id = r.run_id AND m.thread_id = r.thread_id
  LEFT JOIN orchestration_v2_projection_provider_threads p ON r.provider_thread_id = p.provider_thread_id
  WHERE t.deleted_at IS NULL AND m.role = 'user'
    AND json_extract(m.payload_json, '$.createdBy') = 'user'
    AND json_extract(m.payload_json, '$.creationSource') IN ('web', 'mobile')
    AND json_extract(m.payload_json, '$.notification') IS NULL
    AND json_extract(m.payload_json, '$.idleCompaction') IS NULL
  ORDER BY m.created_at, m.message_id
`;

function imageReferences(value) {
  let context;
  try { context = value ? JSON.parse(value) : null; }
  catch (error) { throw new Error('Invalid T3 context metadata', { cause: error }); }
  const refs = new Map();
  if (context?.version !== 1 || !Array.isArray(context.records)) return refs;
  for (const record of context.records) {
    if (record?.kind !== 'image' || typeof record.attachmentId !== 'string' || typeof record.contextId !== 'string' || !/^[\w-]+$/.test(record.contextId)) continue;
    if (!refs.has(record.attachmentId)) refs.set(record.attachmentId, []);
    refs.get(record.attachmentId).push(record.contextId);
  }
  return refs;
}

function submittedAttachments(value, thread, context) {
  let attachments;
  try { attachments = value ? JSON.parse(value) : []; }
  catch (error) { throw new Error('Invalid T3 attachment metadata', { cause: error }); }
  if (!Array.isArray(attachments)) return [];
  const refs = imageReferences(context);
  return attachments.filter(item => typeof item?.id === 'string' && /^[\w-]+$/.test(item.id) && item.id.startsWith(`${thread}-`))
    .map(({ id, name, mimeType }) => ({
      id,
      name: typeof name === 'string' ? name : id,
      mimeType: typeof mimeType === 'string' ? mimeType : '',
      refs: [...new Set(refs.get(id))],
    }));
}

export async function readT3Submissions(dataDirectory, { signal } = {}) {
  const database = join(dataDirectory, 'userdata', 'statev2.sqlite');
  const { stdout } = await exec('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', database, query], {
    timeout: 10000, maxBuffer: 32 * 1024 * 1024, signal,
  });
  let rows;
  try { rows = stdout.trim() ? JSON.parse(stdout) : []; }
  catch (error) { throw new Error('Invalid T3 query result', { cause: error }); }
  return rows.flatMap(row => {
    const record = submission({
      ...row,
      source: 't3code',
      agent: agentAliases.get(row.agent) || row.agent,
      attachments: submittedAttachments(row.attachments, row.session, row.context),
    });
    return record ? [record] : [];
  });
}
