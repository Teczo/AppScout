import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type TranscriptStatus = 'ok' | 'unavailable' | 'error';
export type ExtractionConfidence = 'high' | 'medium' | 'low';
export type ResearchStatus = 'complete' | 'partial' | 'not_found';

export interface ChannelRow {
  id: number;
  channel_url: string;
  channel_name: string;
  video_count: number;
  ingested_at: string;
}

export interface VideoRow {
  id: number;
  channel_id: number;
  video_id: string;
  title: string;
  published_at: string;
  transcript_status: TranscriptStatus;
  transcript_text: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_url TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  video_count INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_url)
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  video_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  transcript_status TEXT NOT NULL CHECK (transcript_status IN ('ok','unavailable','error')),
  transcript_text TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending','done','failed','skipped'))
);

CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT,
  niche TEXT,
  claimed_revenue TEXT,
  founder TEXT,
  extraction_confidence TEXT NOT NULL CHECK (extraction_confidence IN ('high','medium','low'))
);
CREATE INDEX IF NOT EXISTS idx_apps_normalized_name ON apps(normalized_name);

CREATE TABLE IF NOT EXISTS research (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES apps(id),
  verified_revenue TEXT,
  revenue_source_url TEXT,
  target_market TEXT,
  pricing_model TEXT,
  launch_year INTEGER,
  distribution_channel TEXT,
  success_factors TEXT,
  research_status TEXT NOT NULL CHECK (research_status IN ('complete','partial','not_found')),
  sources_json TEXT,
  researched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  trends_md TEXT NOT NULL,
  ideas_md TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export { normalizeAppName } from './util.js';

export function upsertChannel(
  db: Database.Database,
  channel: { channel_url: string; channel_name: string; video_count: number },
): number {
  const existing = db
    .prepare('SELECT id FROM channels WHERE channel_url = ?')
    .get(channel.channel_url) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE channels SET channel_name = ?, video_count = ?, ingested_at = datetime(\'now\') WHERE id = ?')
      .run(channel.channel_name, channel.video_count, existing.id);
    return existing.id;
  }
  const result = db
    .prepare('INSERT INTO channels (channel_url, channel_name, video_count) VALUES (?, ?, ?)')
    .run(channel.channel_url, channel.channel_name, channel.video_count);
  return Number(result.lastInsertRowid);
}

export function getVideoByYoutubeId(db: Database.Database, videoId: string): VideoRow | undefined {
  return db.prepare('SELECT * FROM videos WHERE video_id = ?').get(videoId) as VideoRow | undefined;
}

export function upsertVideo(
  db: Database.Database,
  video: {
    channel_id: number;
    video_id: string;
    title: string;
    published_at: string;
    transcript_status: TranscriptStatus;
    transcript_text: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO videos (channel_id, video_id, title, published_at, transcript_status, transcript_text)
     VALUES (@channel_id, @video_id, @title, @published_at, @transcript_status, @transcript_text)
     ON CONFLICT(video_id) DO UPDATE SET
       title = excluded.title,
       published_at = excluded.published_at,
       transcript_status = excluded.transcript_status,
       transcript_text = excluded.transcript_text`,
  ).run(video);
}

export interface StatusCounts {
  channels: number;
  videos: number;
  transcripts: Record<string, number>;
  extraction: Record<string, number>;
  apps: number;
  research: Record<string, number>;
  reports: number;
}

export function getStatusCounts(db: Database.Database): StatusCounts {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const grouped = (sql: string): Record<string, number> => {
    const rows = db.prepare(sql).all() as { key: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.n]));
  };
  return {
    channels: count('SELECT COUNT(*) AS n FROM channels'),
    videos: count('SELECT COUNT(*) AS n FROM videos'),
    transcripts: grouped('SELECT transcript_status AS key, COUNT(*) AS n FROM videos GROUP BY transcript_status'),
    extraction: grouped('SELECT extraction_status AS key, COUNT(*) AS n FROM videos GROUP BY extraction_status'),
    apps: count('SELECT COUNT(*) AS n FROM apps'),
    research: grouped('SELECT research_status AS key, COUNT(*) AS n FROM research GROUP BY research_status'),
    reports: count('SELECT COUNT(*) AS n FROM reports'),
  };
}
