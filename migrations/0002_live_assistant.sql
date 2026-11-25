CREATE TABLE live_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  connections INTEGER NOT NULL DEFAULT 0,
  questions INTEGER NOT NULL DEFAULT 0,
  speeches INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX live_sessions_daily ON live_sessions(day, workspace_id);
