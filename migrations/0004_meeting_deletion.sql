ALTER TABLE meetings ADD COLUMN deleted_at INTEGER;

CREATE TABLE meeting_attempts (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  attempt TEXT NOT NULL,
  PRIMARY KEY (meeting_id, attempt)
);

INSERT INTO meeting_attempts (meeting_id, attempt)
SELECT id, attempt FROM meetings WHERE attempt IS NOT NULL;
