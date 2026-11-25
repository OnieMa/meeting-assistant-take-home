export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  PROCESS: Workflow<ProcessInput>;
  AI: Ai;
  APP_MODE?: string;
  PUBLIC_ORIGIN?: string;
  DEEPGRAM_API_KEY?: string;
  JOB_SECRET?: string;
}

export interface ProcessInput {
  meetingId: string;
  attempt: string;
}

export interface Meeting {
  id: string;
  workspace_id: string;
  title: string;
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
export const callbackKey = (attempt: string) => `jobs/${attempt}/callback.json`;
export const partKey = (attempt: string, part: number) => `jobs/${attempt}/transcript/${part}.json`;

export const meetingById = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM meetings WHERE id = ?').bind(id).first<Meeting>();
