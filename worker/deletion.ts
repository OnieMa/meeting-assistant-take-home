import type { WorkflowStep } from 'cloudflare:workers';
import { ApiError, json } from './http';
import { attemptPrefix, mediaKey } from './types';
import type { Env } from './types';

export async function deleteMeeting(env: Env, id: string, workspace: string) {
  const meeting = await env.DB.prepare("SELECT id FROM meetings WHERE id = ? AND workspace_id = ? AND state != 'uploading'")
    .bind(id, workspace).first<string>('id');
  if (!meeting) throw new ApiError(404, 'not_found');

  // Establish durable cleanup before hiding the record. A retried request uses the same instance.
  const cleanupId = 'delete-' + id;
  try {
    await env.PROCESS.create({ id: cleanupId, params: { meetingId: id, action: 'delete' } });
  } catch {
    try {
      const instance = await env.PROCESS.get(cleanupId);
      const { status } = await instance.status();
      if (status === 'errored' || status === 'terminated') await instance.restart();
      else if (status === 'unknown') throw new Error('cleanup_not_found');
    } catch {
      throw new ApiError(503, 'delete_failed');
    }
  }

  await hideMeeting(env, id);
  return json({ deleted: true }, 202);
}

function hideMeeting(env: Env, id: string) {
  return env.DB.prepare('UPDATE meetings SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(Date.now(), id).run();
}

const active = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause', 'rollingBack']);
const cleanupRetry = { retries: { limit: 8, delay: '5 seconds', backoff: 'exponential' } } as const;

async function stopProcessing(env: Env, attempt: string) {
  const instance = await env.PROCESS.get(attempt).catch(() => null);
  if (!instance) return;
  const status = await instance.status().catch(() => null);
  if (!status || !active.has(status.status)) return;
  try {
    await instance.terminate();
  } catch (error) {
    const current = await instance.status();
    if (active.has(current.status)) throw error;
  }
}

async function removeAttemptObjects(env: Env, step: WorkflowStep, attempt: string, pass: number) {
  for (let page = 0; ; page++) {
    const more = await step.do(`remove media ${pass} ${attempt} ${page}`, cleanupRetry, async () => {
      const { objects, truncated } = await env.MEDIA.list({ prefix: attemptPrefix(attempt), limit: 100 });
      if (objects.length) await env.MEDIA.delete(objects.map(({ key }) => key));
      return truncated;
    });
    if (!more) return;
  }
}

export async function removeMeeting(env: Env, step: WorkflowStep, id: string) {
  const attempts = await step.do('hide meeting and find attempts', cleanupRetry, async () => {
    await hideMeeting(env, id);
    const result = await env.DB.prepare(`SELECT attempt FROM meeting_attempts WHERE meeting_id = ?
      UNION SELECT attempt FROM meetings WHERE id = ? AND attempt IS NOT NULL ORDER BY attempt`)
      .bind(id, id).all<{ attempt: string }>();
    return result.results.map(({ attempt }) => attempt);
  });
  for (const attempt of attempts) {
    await step.do('stop processing ' + attempt, cleanupRetry, () => stopProcessing(env, attempt));
  }
  await step.do('remove original recording', cleanupRetry, () => env.MEDIA.delete(mediaKey(id)));
  for (const attempt of attempts) await removeAttemptObjects(env, step, attempt, 1);

  // An R2 write already underway when processing stopped may complete after the first pass.
  if (attempts.length) {
    await step.sleep('allow in-flight writes to finish', '15 seconds');
    for (const attempt of attempts) await removeAttemptObjects(env, step, attempt, 2);
  }
  await step.do('remove meeting record', cleanupRetry, async () => {
    await env.DB.prepare('DELETE FROM meetings WHERE id = ? AND deleted_at IS NOT NULL').bind(id).run();
  });
}
