import type Database from 'better-sqlite3';
import { YoutubeTranscript } from 'youtube-transcript';
import { getVideoByYoutubeId, upsertChannel, upsertVideo, type TranscriptStatus } from './db.js';
import type { Logger } from './logger.js';
import { withRetry } from './retry.js';
import { YouTubeClient } from './youtube.js';

export type TranscriptFetcher = (videoId: string) => Promise<string>;

/** Default transcript fetcher backed by the youtube-transcript package. */
export const fetchTranscriptDefault: TranscriptFetcher = async (videoId) => {
  const segments = await YoutubeTranscript.fetchTranscript(videoId);
  return segments.map((s) => s.text).join(' ').trim();
};

export interface IngestResult {
  channelId: number;
  channelName: string;
  videosListed: number;
  videosSkipped: number;
  transcripts: Record<TranscriptStatus, number>;
}

/** Errors from youtube-transcript that mean "no captions", not a real failure. */
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

/**
 * Stage 1: resolve the channel, list videos (newest first, capped), fetch a
 * transcript per video. Idempotent: videos already stored with
 * transcript_status='ok' are skipped. One failing video never halts the batch.
 */
export async function runIngest(
  db: Database.Database,
  logger: Logger,
  opts: {
    channelUrl: string;
    youtubeApiKey: string;
    maxVideos: number;
    fetchFn?: typeof fetch;
    fetchTranscript?: TranscriptFetcher;
  },
): Promise<IngestResult> {
  const yt = new YouTubeClient(opts.youtubeApiKey, opts.fetchFn);
  const fetchTranscript = opts.fetchTranscript ?? fetchTranscriptDefault;

  logger.info(`Ingest: resolving channel ${opts.channelUrl}`);
  const channel = await yt.resolveChannel(opts.channelUrl);
  logger.info(`Ingest: channel "${channel.title}" (${channel.channelId})`);

  const videos = await yt.listVideos(channel.uploadsPlaylistId, opts.maxVideos);
  logger.info(`Ingest: listed ${videos.length} videos (cap ${opts.maxVideos})`);

  const channelRowId = upsertChannel(db, {
    channel_url: opts.channelUrl,
    channel_name: channel.title,
    video_count: videos.length,
  });

  const counts: Record<TranscriptStatus, number> = { ok: 0, unavailable: 0, error: 0 };
  let skipped = 0;

  for (const video of videos) {
    const existing = getVideoByYoutubeId(db, video.videoId);
    if (existing?.transcript_status === 'ok') {
      skipped++;
      continue;
    }

    let status: TranscriptStatus;
    let text: string | null = null;
    try {
      text = await withRetry(`transcript ${video.videoId}`, () => fetchTranscript(video.videoId), {
        // No captions is a definitive answer — don't retry it.
        shouldRetry: (err) => !isTranscriptUnavailable(err),
      });
      status = text.length > 0 ? 'ok' : 'unavailable';
    } catch (err) {
      status = isTranscriptUnavailable(err) ? 'unavailable' : 'error';
      logger.warn(`Ingest: transcript ${status} for ${video.videoId} ("${video.title}"): ${String(err).slice(0, 200)}`);
    }

    counts[status]++;
    upsertVideo(db, {
      channel_id: channelRowId,
      video_id: video.videoId,
      title: video.title,
      published_at: video.publishedAt,
      transcript_status: status,
      transcript_text: text,
    });
  }

  logger.info(
    `Ingest: done. ok=${counts.ok} unavailable=${counts.unavailable} error=${counts.error} skipped=${skipped}`,
  );
  return {
    channelId: channelRowId,
    channelName: channel.title,
    videosListed: videos.length,
    videosSkipped: skipped,
    transcripts: counts,
  };
}
