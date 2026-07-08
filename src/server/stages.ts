import Anthropic from '@anthropic-ai/sdk';
import { extractFromTranscript, TRANSCRIPT_CHAR_LIMIT } from '../extract.js';
import { fetchTranscriptDefault } from '../ingest.js';
import { researchApp, type AppToResearch, type LoggerLike } from '../research.js';
import { withRetry } from '../retry.js';
import { synthesizeReport } from '../synthesize.js';
import { normalizeAppName } from '../util.js';
import { YouTubeClient, type VideoListing } from '../youtube.js';
import { query, upsertChannel } from './pg.js';

/**
 * Postgres-backed stage orchestrators for the Phase 2 web app. Each function
 * is sized to run inside one Inngest step and is idempotent/resumable — the
 * same DB-state-driven semantics as the Phase 1 CLI runners.
 */

const consoleLogger: LoggerLike = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function anthropic(): Anthropic {
  return new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), maxRetries: 3 });
}

export function maxVideos(): number {
  return Number.parseInt(process.env.MAX_VIDEOS ?? '100', 10);
}

export function maxResearchIterations(): number {
  return Number.parseInt(process.env.MAX_RESEARCH_ITERATIONS ?? '8', 10);
}

// ---------- estimate (for the confirmation modal) ----------

export interface RunEstimate {
  channelName: string;
  videoCount: number;
  estimatedCostUsd: number;
}

export async function estimateRun(channelUrl: string): Promise<RunEstimate> {
  const yt = new YouTubeClient(env('YOUTUBE_API_KEY'));
  const channel = await yt.resolveChannel(channelUrl);
  const videos = await yt.listVideos(channel.uploadsPlaylistId, maxVideos());
  // Extraction ~ $0.014/video (Haiku); research ~ $0.19/unique app, apps ≈ videos as upper bound.
  const cost = videos.length * 0.014 + videos.length * (maxResearchIterations() * 0.01 + 0.11) + 0.2;
  return { channelName: channel.title, videoCount: videos.length, estimatedCostUsd: cost };
}

// ---------- stage 1: ingest ----------

export async function ingestResolve(
  channelUrl: string,
): Promise<{ channelId: number; channelName: string; videos: VideoListing[] }> {
  const yt = new YouTubeClient(env('YOUTUBE_API_KEY'));
  const channel = await yt.resolveChannel(channelUrl);
  const videos = await yt.listVideos(channel.uploadsPlaylistId, maxVideos());
  const channelId = await upsertChannel(channelUrl, channel.title, videos.length);
  return { channelId, channelName: channel.title, videos };
}

function isTranscriptUnavailable(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes('transcript is disabled') ||
    msg.includes('transcripts disabled') ||
    msg.includes('no transcript') ||
    msg.includes('transcript not available') ||
    msg.includes('unavailable')
  );
}

/** Fetch transcripts for a chunk of videos. Skips videos already ok. */
export async function ingestTranscripts(
  channelId: number,
  videos: VideoListing[],
): Promise<{ ok: number; unavailable: number; error: number; skipped: number }> {
  const counts = { ok: 0, unavailable: 0, error: 0, skipped: 0 };
  for (const video of videos) {
    const existing = await query<{ transcript_status: string }>(
      'SELECT transcript_status FROM videos WHERE video_id = $1',
      [video.videoId],
    );
    if (existing[0]?.transcript_status === 'ok') {
      counts.skipped++;
      continue;
    }
    let status: 'ok' | 'unavailable' | 'error';
    let text: string | null = null;
    try {
      text = await withRetry(`transcript ${video.videoId}`, () => fetchTranscriptDefault(video.videoId), {
        shouldRetry: (err) => !isTranscriptUnavailable(err),
      });
      status = text.length > 0 ? 'ok' : 'unavailable';
    } catch (err) {
      status = isTranscriptUnavailable(err) ? 'unavailable' : 'error';
    }
    counts[status]++;
    await query(
      `INSERT INTO videos (channel_id, video_id, title, published_at, transcript_status, transcript_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (video_id) DO UPDATE SET
         title = EXCLUDED.title, published_at = EXCLUDED.published_at,
         transcript_status = EXCLUDED.transcript_status, transcript_text = EXCLUDED.transcript_text`,
      [channelId, video.videoId, video.title, video.publishedAt, status, text],
    );
  }
  return counts;
}

// ---------- stage 2: extract ----------

/** Extract a chunk of pending videos. Returns how many were processed (0 = done). */
export async function extractChunk(limit: number): Promise<number> {
  const pending = await query<{ id: number; video_id: string; transcript_text: string }>(
    `SELECT id, video_id, transcript_text FROM videos
     WHERE transcript_status = 'ok' AND extraction_status = 'pending'
     ORDER BY id LIMIT $1`,
    [limit],
  );
  if (pending.length === 0) return 0;

  const client = anthropic();
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (const video of pending) {
    try {
      const apps = await extractFromTranscript(client, video.transcript_text.slice(0, TRANSCRIPT_CHAR_LIMIT), usage);
      for (const app of apps) {
        await query(
          `INSERT INTO apps (video_id, name, normalized_name, description, niche, claimed_revenue, founder, extraction_confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [video.id, app.name, normalizeAppName(app.name), app.description, app.niche, app.claimed_revenue, app.founder, app.extraction_confidence],
        );
      }
      await query(`UPDATE videos SET extraction_status = 'done' WHERE id = $1`, [video.id]);
    } catch (err) {
      console.error(`extract failed for ${video.video_id}: ${String(err).slice(0, 300)}`);
      await query(`UPDATE videos SET extraction_status = 'failed' WHERE id = $1`, [video.id]);
    }
  }
  return pending.length;
}

// ---------- stage 3: research ----------

/** IDs of canonical apps (deduped by normalized_name) still pending research. */
export async function pendingResearchAppIds(channelId: number): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `SELECT MIN(a.id) AS id
     FROM apps a JOIN videos v ON v.id = a.video_id
     WHERE v.channel_id = $1
       AND a.normalized_name NOT IN (
         SELECT a2.normalized_name FROM apps a2 JOIN research r ON r.app_id = a2.id
       )
     GROUP BY a.normalized_name`,
    [channelId],
  );
  return rows.map((r) => r.id);
}

/** Research one app (one Inngest step). Skips if already researched. */
export async function researchOne(appId: number): Promise<string> {
  const already = await query('SELECT 1 FROM research WHERE app_id = $1', [appId]);
  if (already.length > 0) return 'skipped';

  const rows = await query<AppToResearch & { normalized_name: string }>(
    `SELECT a.id, a.name, a.description, a.niche, a.claimed_revenue, a.founder, a.normalized_name,
            (SELECT COUNT(*) FROM apps d WHERE d.normalized_name = a.normalized_name)::int AS video_count
     FROM apps a WHERE a.id = $1`,
    [appId],
  );
  const app = rows[0];
  if (!app) throw new Error(`app ${appId} not found`);

  const usage = { inputTokens: 0, outputTokens: 0 };
  const { output } = await researchApp(anthropic(), app, maxResearchIterations(), usage, consoleLogger);
  await query(
    `INSERT INTO research (app_id, verified_revenue, revenue_source_url, target_market, pricing_model,
                           launch_year, distribution_channel, success_factors, research_status, sources_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      appId,
      output.verified_revenue,
      output.revenue_source_url,
      output.target_market,
      output.pricing_model,
      output.launch_year,
      output.distribution_channel,
      output.success_factors ? JSON.stringify(output.success_factors) : null,
      output.research_status,
      JSON.stringify({ sources: output.sources, notes: output.notes }),
    ],
  );
  return output.research_status;
}

// ---------- stage 4: synthesize ----------

export async function getCorpus(channelId: number): Promise<Record<string, unknown>[]> {
  const rows = await query(
    `SELECT a.name, a.description, a.niche, a.claimed_revenue, a.founder, a.extraction_confidence,
            r.verified_revenue, r.revenue_source_url, r.target_market, r.pricing_model,
            r.launch_year, r.distribution_channel, r.success_factors, r.research_status, r.sources_json
     FROM research r
     JOIN apps a ON a.id = r.app_id
     JOIN videos v ON v.id = a.video_id
     WHERE v.channel_id = $1
     ORDER BY a.name`,
    [channelId],
  );
  return rows.map((row) => ({
    ...row,
    success_factors: row.success_factors ? JSON.parse(row.success_factors as string) : null,
    sources_json: row.sources_json ? JSON.parse(row.sources_json as string) : null,
  }));
}

/** Synthesize the report (skips when up to date). Returns report id or null when skipped/empty. */
export async function synthesize(channelId: number): Promise<number | null> {
  const corpus = await getCorpus(channelId);
  if (corpus.length === 0) return null;

  const upToDate = await query(
    `SELECT 1 FROM reports
     WHERE channel_id = $1
       AND created_at >= (SELECT MAX(r.researched_at) FROM research r
                          JOIN apps a ON a.id = r.app_id JOIN videos v ON v.id = a.video_id
                          WHERE v.channel_id = $1)`,
    [channelId],
  );
  if (upToDate.length > 0) return null;

  const usage = { inputTokens: 0, outputTokens: 0 };
  const report = await synthesizeReport(anthropic(), corpus, usage);
  const inserted = await query<{ id: number }>(
    'INSERT INTO reports (channel_id, trends_md, ideas_md) VALUES ($1, $2, $3) RETURNING id',
    [channelId, report.trends_md, report.ideas_md],
  );
  return inserted[0]!.id;
}

// ---------- chat (Phase 2 feature) ----------

const CHAT_MODEL = 'claude-sonnet-4-6';

export async function chatWithFindings(channelId: number, question: string): Promise<string> {
  const corpus = await getCorpus(channelId);
  if (corpus.length === 0) {
    return 'No research findings exist for this channel yet — run the pipeline first.';
  }
  const client = anthropic();
  const response = await client.messages.create({
    model: CHAT_MODEL,
    max_tokens: 2000,
    system:
      'You answer questions about a corpus of researched apps from a YouTube channel. ' +
      'Use only the corpus provided — cite app names, and distinguish verified from claimed revenue. ' +
      'If the corpus does not contain the answer, say so.',
    messages: [
      {
        role: 'user',
        content: `<research_corpus>\n${JSON.stringify(corpus, null, 1)}\n</research_corpus>\n\nQuestion: ${question}`,
      },
    ],
  });
  return response.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
