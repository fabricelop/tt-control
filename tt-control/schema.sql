CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'europapress',
  source_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  url TEXT,
  section TEXT,
  published_at TEXT,
  detected_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  radar_score REAL,
  radar_reason TEXT,
  urgent INTEGER NOT NULL DEFAULT 0,
  urgency_score REAL,
  urgency_reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_status ON news(status);
CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC);

CREATE TABLE IF NOT EXISTS editorial_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(news_id) REFERENCES news(id)
);
CREATE INDEX IF NOT EXISTS idx_feedback_news ON editorial_feedback(news_id);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL,
  discovered INTEGER NOT NULL DEFAULT 0,
  admitted INTEGER NOT NULL DEFAULT 0,
  radar_dismissed INTEGER NOT NULL DEFAULT 0,
  urgent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  error TEXT
);
