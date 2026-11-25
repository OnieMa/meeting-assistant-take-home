CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'queued', 'transcribing', 'writing', 'ready', 'failed')),
  error TEXT,
  attempt TEXT,
  transcript_parts INTEGER NOT NULL DEFAULT 0,
  duration REAL,
  notes_zh TEXT,
  notes_en TEXT,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX meetings_workspace_date ON meetings(workspace_id, created_at DESC);
