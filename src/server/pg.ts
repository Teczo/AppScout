import { Pool, type QueryResultRow } from 'pg';

/**
 * Postgres data layer for the Phase 2 web app (Neon / Vercel Postgres).
 * Mirrors the Phase 1 SQLite schema in src/db.ts, plus a `runs` table for
 * background-job progress tracking.
 */

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Missing required environment variable DATABASE_URL.');
    pool = new Pool({ connectionString: url, max: 5 });
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  channel_url TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL,
  video_count INTEGER NOT NULL DEFAULT 0,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
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
  researched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  trends_md TEXT NOT NULL,
  ideas_md TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id SERIAL PRIMARY KEY,
  channel_url TEXT NOT NULL,
  channel_id INTEGER REFERENCES channels(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','complete','error')),
  stage TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!schemaReady) schemaReady = getPool().query(SCHEMA).then(() => undefined);
  await schemaReady;
  const result = await getPool().query<T>(text, params as any[]);
  return result.rows;
}

// ---------- runs ----------

export interface RunRow {
  id: number;
  channel_url: string;
  channel_id: number | null;
  status: 'queued' | 'running' | 'complete' | 'error';
  stage: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export async function createRun(channelUrl: string): Promise<number> {
  const rows = await query<{ id: number }>(
    'INSERT INTO runs (channel_url) VALUES ($1) RETURNING id',
    [channelUrl],
  );
  return rows[0]!.id;
}

export async function updateRun(
  id: number,
  fields: { status?: string; stage?: string; channel_id?: number; error?: string },
): Promise<void> {
  await query(
    `UPDATE runs SET
       status = COALESCE($2, status),
       stage = COALESCE($3, stage),
       channel_id = COALESCE($4, channel_id),
       error = COALESCE($5, error),
       updated_at = now()
     WHERE id = $1`,
    [id, fields.status ?? null, fields.stage ?? null, fields.channel_id ?? null, fields.error ?? null],
  );
}

export async function getRun(id: number): Promise<RunRow | undefined> {
  const rows = await query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
  return rows[0];
}

// ---------- channels / progress ----------

export async function upsertChannel(
  channelUrl: string,
  channelName: string,
  videoCount: number,
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO channels (channel_url, channel_name, video_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel_url) DO UPDATE SET
       channel_name = EXCLUDED.channel_name,
       video_count = EXCLUDED.video_count,
       ingested_at = now()
     RETURNING id`,
    [channelUrl, channelName, videoCount],
  );
  return rows[0]!.id;
}

export interface ChannelProgress {
  videos: number;
  transcripts: Record<string, number>;
  extraction: Record<string, number>;
  appsTotal: number;
  appsUnique: number;
  research: Record<string, number>;
  reports: number;
}

export async function getChannelProgress(channelId: number): Promise<ChannelProgress> {
  const grouped = async (sql: string): Promise<Record<string, number>> => {
    const rows = await query<{ key: string; n: string }>(sql, [channelId]);
    return Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
  };
  const one = async (sql: string): Promise<number> =>
    Number((await query<{ n: string }>(sql, [channelId]))[0]?.n ?? 0);

  return {
    videos: await one('SELECT COUNT(*) AS n FROM videos WHERE channel_id = $1'),
    transcripts: await grouped(
      'SELECT transcript_status AS key, COUNT(*) AS n FROM videos WHERE channel_id = $1 GROUP BY 1',
    ),
    extraction: await grouped(
      'SELECT extraction_status AS key, COUNT(*) AS n FROM videos WHERE channel_id = $1 GROUP BY 1',
    ),
    appsTotal: await one(
      'SELECT COUNT(*) AS n FROM apps a JOIN videos v ON v.id = a.video_id WHERE v.channel_id = $1',
    ),
    appsUnique: await one(
      `SELECT COUNT(DISTINCT a.normalized_name) AS n FROM apps a
       JOIN videos v ON v.id = a.video_id WHERE v.channel_id = $1`,
    ),
    research: await grouped(
      `SELECT r.research_status AS key, COUNT(*) AS n FROM research r
       JOIN apps a ON a.id = r.app_id JOIN videos v ON v.id = a.video_id
       WHERE v.channel_id = $1 GROUP BY 1`,
    ),
    reports: await one('SELECT COUNT(*) AS n FROM reports WHERE channel_id = $1'),
  };
}

export interface ChannelListRow {
  id: number;
  channel_url: string;
  channel_name: string;
  video_count: number;
  apps_unique: number;
  has_report: boolean;
}

export async function listChannels(): Promise<ChannelListRow[]> {
  return query<ChannelListRow>(
    `SELECT c.id, c.channel_url, c.channel_name, c.video_count,
            (SELECT COUNT(DISTINCT a.normalized_name) FROM apps a JOIN videos v ON v.id = a.video_id
             WHERE v.channel_id = c.id)::int AS apps_unique,
            EXISTS (SELECT 1 FROM reports r WHERE r.channel_id = c.id) AS has_report
     FROM channels c ORDER BY c.ingested_at DESC`,
  );
}

// ---------- results (apps + research) ----------

export interface AppResultRow {
  name: string;
  niche: string | null;
  description: string | null;
  founder: string | null;
  extraction_confidence: string;
  video_count: number;
  claimed_revenue: string | null;
  research_status: string | null;
  verified_revenue: string | null;
  revenue_source_url: string | null;
  target_market: string | null;
  pricing_model: string | null;
  launch_year: number | null;
  distribution_channel: string | null;
  success_factors: string | null;
  sources_json: string | null;
}

/** One row per unique app (canonical = lowest id per normalized_name) with research. */
export async function getAppResults(channelId: number): Promise<AppResultRow[]> {
  return query<AppResultRow>(
    `SELECT a.name, a.niche, a.description, a.founder, a.extraction_confidence, a.claimed_revenue,
            (SELECT COUNT(*) FROM apps d JOIN videos dv ON dv.id = d.video_id
             WHERE d.normalized_name = a.normalized_name AND dv.channel_id = $1)::int AS video_count,
            r.research_status, r.verified_revenue, r.revenue_source_url, r.target_market,
            r.pricing_model, r.launch_year, r.distribution_channel, r.success_factors, r.sources_json
     FROM apps a
     JOIN videos v ON v.id = a.video_id
     LEFT JOIN research r ON r.app_id = a.id
     WHERE v.channel_id = $1
       AND a.id = (SELECT MIN(a2.id) FROM apps a2 WHERE a2.normalized_name = a.normalized_name)
     ORDER BY a.name`,
    [channelId],
  );
}

export interface ReportRow {
  id: number;
  trends_md: string;
  ideas_md: string;
  created_at: string;
}

export async function getLatestReport(channelId: number): Promise<ReportRow | undefined> {
  const rows = await query<ReportRow>(
    'SELECT id, trends_md, ideas_md, created_at FROM reports WHERE channel_id = $1 ORDER BY id DESC LIMIT 1',
    [channelId],
  );
  return rows[0];
}

export async function getChannel(
  channelId: number,
): Promise<{ id: number; channel_name: string; channel_url: string } | undefined> {
  const rows = await query<{ id: number; channel_name: string; channel_url: string }>(
    'SELECT id, channel_name, channel_url FROM channels WHERE id = $1',
    [channelId],
  );
  return rows[0];
}
