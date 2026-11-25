export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  PROCESS: Workflow<ProcessInput>;
  AI: Ai;
  APP_MODE?: string;
  PUBLIC_ORIGIN?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  JOB_SECRET?: string;
}

export type ProcessInput =
  | { meetingId: string; attempt: string }
  | { meetingId: string; action: 'delete' };

export interface Meeting {
  id: string;
  workspace_id: string;
  title: string;
  title_source: 'manual' | 'auto';
  suggested_title: string | null;
  mime: string;
  size: number;
  created_at: number;
  state: 'uploading' | 'queued' | 'transcribing' | 'writing' | 'ready' | 'failed';
  error: string | null;
  attempt: string | null;
  transcript_parts: number;
  duration: number | null;
  notes_zh: string | null;
  notes_en: string | null;
  version: number;
}

export interface Segment {
  start: number;
  end: number;
  speaker: number;
  text: string;
}

export const mediaKey = (id: string) => `meetings/${id}/audio`;
export const attemptPrefix = (attempt: string) => `jobs/${attempt}/`;
export const callbackKey = (attempt: string) => attemptPrefix(attempt) + 'callback.json';
export const partKey = (attempt: string, part: number) => `${attemptPrefix(attempt)}transcript/${part}.json`;

export const meetingById = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL').bind(id).first<Meeting>();

export const meetingExists = (db: D1Database, id: string) =>
  db.prepare('SELECT 1 AS active FROM meetings WHERE id = ? AND deleted_at IS NULL')
    .bind(id).first<number>('active');
