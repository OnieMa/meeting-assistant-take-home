ALTER TABLE meetings ADD COLUMN title_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (title_source IN ('manual', 'auto'));
ALTER TABLE meetings ADD COLUMN suggested_title TEXT;
