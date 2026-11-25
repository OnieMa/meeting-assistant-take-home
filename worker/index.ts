import { ApiError, json, smallJson } from './http';
import { handleLive } from './live';
import { accessCode, currentWorkspace, hash, jobProof, matches, newSession, normalizedCode, sessionCookie, sessionToken } from './security';
import { callbackKey, mediaKey, meetingById, partKey } from './types';
import type { Env, Meeting } from './types';
import { suggestExistingTitle, translateNotes } from './notes';
export { MeetingProcessing } from './workflow';

const maxAudioBytes = 95_000_000;
const idPattern = '[0-9a-f-]{36}';
const jobsPath = new RegExp(`^/api/jobs/(${idPattern})/(${idPattern})/(source|callback)$`);
const meetingsPath = new RegExp(`^/api/meetings/(${idPattern})(?:/(audio|transcript|notes|retry|title))?$`);
const allowedMime = /^(audio\/[a-z0-9.+-]+|video\/(webm|mp4|ogg)|application\/ogg)$/i;

type MeetingSummary = Pick<Meeting, 'id' | 'title' | 'created_at' | 'state' | 'error' | 'size' | 'duration'>;

function meetingSummary({ id, title, created_at, state, error, size, duration }: MeetingSummary) {
  return { id, title, createdAt: created_at, state, error, size, duration };
}

function meetingView(meeting: Meeting) {
  const { transcript_parts, notes_zh, notes_en, title_source, suggested_title, version } = meeting;
  return {
    ...meetingSummary(meeting),
    transcriptParts: transcript_parts, notes: { zh: notes_zh, en: notes_en }, version,
    titleSource: title_source, suggestedTitle: suggested_title,
  };
}

async function audio(env: Env, request: Request, meeting: Meeting) {
  const range = request.headers.get('Range');
  let offset = 0;
  let length = meeting.size;
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Type': meeting.mime,
    'X-Content-Type-Options': 'nosniff',
  });
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const [, first, last] = match;
      offset = first ? Number(first) : Math.max(meeting.size - Number(last), 0);
      const end = first && last ? Math.min(Number(last), meeting.size - 1) : meeting.size - 1;
      length = end - offset + 1;
    }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(offset) || offset >= meeting.size ||
        !Number.isSafeInteger(length) || length <= 0) {
      headers.set('Content-Range', `bytes */${meeting.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${meeting.size}`);
  }
  const key = mediaKey(meeting.id);
  headers.set('Content-Length', String(length));
  if (request.method === 'HEAD') {
    if (!await env.MEDIA.head(key)) throw new ApiError(404, 'audio_missing');
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const object = await env.MEDIA.get(key, range ? { range: { offset, length } } : undefined);
  if (!object) throw new ApiError(404, 'audio_missing');
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function startJob(env: Env, id: string, expected: Meeting['state']) {
  const attempt = crypto.randomUUID();
  const queued = await env.DB.prepare(
    "UPDATE meetings SET state = 'queued', attempt = ?, error = NULL, transcript_parts = 0, duration = NULL WHERE id = ? AND state = ?",
  ).bind(attempt, id, expected).run();
  if (!queued.meta.changes) throw new ApiError(409, 'state_conflict');
  try {
    await env.PROCESS.create({ id: attempt, params: { meetingId: id, attempt } });
  } catch {
    // A create call can fail after the instance was created. Only mark a job
    // failed while it is still queued and we cannot find the instance.
    try {
      const workflow = await env.PROCESS.get(attempt);
      await workflow.status();
      return;
    } catch {
      await env.DB.prepare("UPDATE meetings SET state = 'failed', error = 'start_failed' WHERE id = ? AND attempt = ? AND state = 'queued'")
        .bind(id, attempt).run();
    }
  }
}

async function upload(request: Request, env: Env, workspace: string, url: URL) {
  const size = Number(request.headers.get('Content-Length'));
  if (!request.body || !Number.isSafeInteger(size) || size <= 0) throw new ApiError(400, 'empty_audio');
  if (size > maxAudioBytes) throw new ApiError(413, 'audio_too_large');
  const mime = request.headers.get('Content-Type')?.split(';')[0].trim() ?? '';
  if (!allowedMime.test(mime)) throw new ApiError(415, 'audio_type');
  const explicitTitle = (url.searchParams.get('title') ?? '').trim().slice(0, 120);
  const fallbackTitle = (url.searchParams.get('fallbackTitle') ?? '').trim().slice(0, 120);
  const title = explicitTitle || fallbackTitle || 'Meeting';
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO meetings (id, workspace_id, title, title_source, mime, size, created_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, workspace, title, explicitTitle ? 'manual' : 'auto', mime, size, Date.now(), 'uploading').run();
  try {
    const object = await env.MEDIA.put(mediaKey(id), request.body, { httpMetadata: { contentType: mime } });
    if (!object || object.size !== size) throw new Error('incomplete_upload');
  } catch {
    await Promise.all([
      env.MEDIA.delete(mediaKey(id)),
      env.DB.prepare("DELETE FROM meetings WHERE id = ? AND state = 'uploading'").bind(id).run(),
    ]);
    throw new ApiError(502, 'upload_failed');
  }
  await startJob(env, id, 'uploading');
  return json(meetingView((await meetingById(env.DB, id))!), 201);
}

async function providerRequest(request: Request, env: Env, url: URL, match: RegExpExecArray) {
  const [, id, attempt, action] = match;
  const secret = env.JOB_SECRET;
  if (!secret) throw new ApiError(404, 'not_found');
  if (action === 'source' && (request.method === 'GET' || request.method === 'HEAD')) {
    const expires = Number(url.searchParams.get('expires'));
    if (!Number.isSafeInteger(expires) || expires < Date.now() / 1000 ||
        !matches(url.searchParams.get('proof') ?? '', await jobProof(secret, `source:${id}:${attempt}:${expires}`))) {
      throw new ApiError(403, 'forbidden');
    }
    const meeting = await meetingById(env.DB, id);
    if (!meeting || meeting.attempt !== attempt || meeting.state !== 'transcribing') throw new ApiError(404, 'not_found');
    return audio(env, request, meeting);
  }
  if (action === 'callback' && request.method === 'POST') {
    const proof = await jobProof(secret, `callback:${id}:${attempt}`);
    if (!matches(request.headers.get('Authorization') ?? '', `Basic ${btoa(`deepgram:${proof}`)}`)) {
      throw new ApiError(403, 'forbidden');
    }
    const meeting = await meetingById(env.DB, id);
    if (!meeting || meeting.attempt !== attempt || meeting.state !== 'transcribing') return new Response(null, { status: 204 });
    if (!request.body) throw new ApiError(400, 'invalid_request');
    const declared = request.headers.get('Content-Length');
    const limit = 20_000_000;
    if (declared && Number(declared) > limit) throw new ApiError(413, 'callback_too_large');
    const key = callbackKey(attempt);
    // The proof is scoped to this job. Streaming keeps the webhook off the JSON parsing path.
    let received = 0;
    const stream = declared
      ? request.body
      : request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > limit) controller.error(new Error('callback_too_large'));
          else controller.enqueue(chunk);
        },
      }));
    await env.MEDIA.put(key, declared ? stream : await new Response(stream).arrayBuffer(), { onlyIf: { etagDoesNotMatch: '*' } });
    return new Response(null, { status: 204 });
  }
  throw new ApiError(404, 'not_found');
}

async function session(request: Request, env: Env) {
  const method = request.method;
  if (method === 'GET') return json({ active: !!await currentWorkspace(request, env), demo: env.APP_MODE === 'demo' });
  if (method === 'DELETE') {
    const token = sessionToken(request);
    if (token && /^[0-9a-f]{64}$/.test(token)) {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hash(token)).run();
    }
    return json({ active: false }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
  }
  if (method !== 'POST') throw new ApiError(405, 'invalid_method');
  const body = await smallJson<{ action?: string; code?: string }>(request);
  if (body.action === 'create') {
    const code = accessCode();
    const workspace = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').bind(
      workspace, await hash(normalizedCode(code)), Date.now(),
    ).run();
    return json({ active: true, code }, 201, { 'Set-Cookie': await newSession(request, env, workspace) });
  }
  if (body.action !== 'open' || typeof body.code !== 'string') throw new ApiError(400, 'invalid_request');
  const code = normalizedCode(body.code);
  if (!/^[2-9A-HJ-NP-Z]{20}$/.test(code)) throw new ApiError(401, 'invalid_code');
  const workspace = await env.DB.prepare('SELECT id FROM workspaces WHERE code_hash = ?')
    .bind(await hash(code)).first<string>('id');
  if (!workspace) throw new ApiError(401, 'invalid_code');
  return json({ active: true }, 200, { 'Set-Cookie': await newSession(request, env, workspace) });
}

async function rename(request: Request, env: Env, meeting: Meeting) {
  const body = await smallJson<{ title?: unknown; mode?: unknown; language?: unknown }>(request, 2_000);
  if (body.mode === 'auto') {
    let suggestion = meeting.suggested_title;
    if (!suggestion && meeting.state === 'ready') {
      const language = body.language === 'zh' ? 'zh' : 'en';
      const notes = language === 'zh' ? meeting.notes_zh : meeting.notes_en;
      if (!notes) throw new ApiError(409, 'state_conflict');
      try {
        suggestion = await suggestExistingTitle(env, notes, language);
      } catch {
        throw new ApiError(502, 'title_generation_failed');
      }
    }
    // A concurrent explicit rename during title generation takes precedence.
    const result = await env.DB.prepare(`UPDATE meetings SET title_source = 'auto',
      title = COALESCE(?, suggested_title, title), suggested_title = COALESCE(?, suggested_title)
      WHERE id = ? AND workspace_id = ? AND title = ? AND title_source = ?`)
      .bind(suggestion, suggestion, meeting.id, meeting.workspace_id, meeting.title, meeting.title_source).run();
    if (!result.meta.changes) throw new ApiError(409, 'title_conflict');
  } else {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 120 || /[\r\n]/.test(title)) throw new ApiError(400, 'invalid_title');
    await env.DB.prepare("UPDATE meetings SET title = ?, title_source = 'manual' WHERE id = ? AND workspace_id = ?")
      .bind(title, meeting.id, meeting.workspace_id).run();
  }
  return json(meetingView((await meetingById(env.DB, meeting.id))!));
}

async function handle(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const provider = jobsPath.exec(path);
  if (provider) return providerRequest(request, env, url, provider);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (origin ? origin !== url.origin : request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      throw new ApiError(403, 'forbidden');
    }
  }
  if (path === '/api/session') return session(request, env);

  const workspace = await currentWorkspace(request, env);
  if (!workspace) throw new ApiError(401, 'no_session');
  if (path === '/api/live' || path.startsWith('/api/live/')) return handleLive(request, env, workspace, url);
  if (path === '/api/meetings') {
    if (request.method === 'POST') return upload(request, env, workspace, url);
    if (request.method === 'GET') {
      const { results } = await env.DB.prepare("SELECT id, title, created_at, state, error, size, duration FROM meetings WHERE workspace_id = ? AND state != 'uploading' ORDER BY created_at DESC")
        .bind(workspace).all<MeetingSummary>();
      return json(results.map(meetingSummary));
    }
  }

  const match = meetingsPath.exec(path);
  if (!match) throw new ApiError(404, 'not_found');
  const [, id, action] = match;
  const meeting = await meetingById(env.DB, id);
  if (!meeting || meeting.workspace_id !== workspace || meeting.state === 'uploading') throw new ApiError(404, 'not_found');
  if (!action && request.method === 'GET') return json(meetingView(meeting));
  if (action === 'title' && request.method === 'PUT') return rename(request, env, meeting);
  if (action === 'audio' && (request.method === 'GET' || request.method === 'HEAD')) return audio(env, request, meeting);
  if (action === 'retry' && request.method === 'POST') {
    if (meeting.state !== 'failed') throw new ApiError(409, 'state_conflict');
    await startJob(env, id, 'failed');
    return json(meetingView((await meetingById(env.DB, id))!), 202);
  }
  if (action === 'transcript' && request.method === 'GET') {
    const part = Number(url.searchParams.get('part') ?? 0);
    if (!meeting.attempt || !Number.isSafeInteger(part) || part < 0 || part >= meeting.transcript_parts) {
      throw new ApiError(404, 'not_found');
    }
    const object = await env.MEDIA.get(partKey(meeting.attempt, part));
    if (!object) throw new ApiError(404, 'not_found');
    return new Response(object.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
  }
  if (action === 'notes' && request.method === 'PUT') {
    const { language, text, version } = await smallJson<{ language: 'zh' | 'en'; text: string; version: number }>(request);
    if ((language !== 'zh' && language !== 'en') || typeof text !== 'string' || !text.trim() || text.length > 12_000) {
      throw new ApiError(400, 'invalid_notes');
    }
    if (meeting.state !== 'ready' || meeting.version !== version) throw new ApiError(409, 'version_conflict');
    let other: string;
    try {
      other = await translateNotes(env, language, text);
    } catch {
      throw new ApiError(502, 'translation_failed');
    }
    const [zh, en] = language === 'zh' ? [text, other] : [other, text];
    const result = await env.DB.prepare('UPDATE meetings SET notes_zh = ?, notes_en = ?, version = version + 1 WHERE id = ? AND workspace_id = ? AND version = ?')
      .bind(zh, en, id, workspace, version).run();
    if (!result.meta.changes) throw new ApiError(409, 'version_conflict');
    return json(meetingView((await meetingById(env.DB, id))!));
  }
  throw new ApiError(405, 'invalid_method');
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      console.error('unexpected api failure', new URL(request.url).pathname.split('/')[2]);
      return json({ error: 'server_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
