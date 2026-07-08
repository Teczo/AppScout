import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { runIngest, type TranscriptFetcher } from '../src/ingest.js';
import type { Logger } from '../src/logger.js';
import type Database from 'better-sqlite3';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  logFilePath: '/dev/null',
} as unknown as Logger;

/** Minimal mock of the two YouTube Data API endpoints ingest uses. */
function mockYouTubeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    if (url.pathname.endsWith('/channels')) {
      return json({
        items: [
          {
            id: 'UCfixture123',
            snippet: { title: 'Indie App Channel' },
            contentDetails: { relatedPlaylists: { uploads: 'UUfixture123' } },
          },
        ],
      });
    }
    if (url.pathname.endsWith('/playlistItems')) {
      return json({
        items: [
          {
            snippet: { title: 'How this app makes $40k MRR', publishedAt: '2026-06-01T00:00:00Z' },
            contentDetails: { videoId: 'vid-1', videoPublishedAt: '2026-06-01T00:00:00Z' },
          },
          {
            snippet: { title: 'No captions on this one', publishedAt: '2026-05-01T00:00:00Z' },
            contentDetails: { videoId: 'vid-2', videoPublishedAt: '2026-05-01T00:00:00Z' },
          },
          {
            snippet: { title: 'Flaky transcript endpoint', publishedAt: '2026-04-01T00:00:00Z' },
            contentDetails: { videoId: 'vid-3', videoPublishedAt: '2026-04-01T00:00:00Z' },
          },
        ],
        // no nextPageToken -> single page
      });
    }
    throw new Error(`Unexpected URL in mock fetch: ${url}`);
  }) as typeof fetch;
}

const mockTranscripts: TranscriptFetcher = async (videoId) => {
  if (videoId === 'vid-1') return 'Today we look at an app called FocusKit making $40k MRR.';
  if (videoId === 'vid-2') throw new Error('Transcript is disabled on this video');
  throw new Error('ECONNRESET'); // vid-3: hard failure, exhausts retries
};

describe('stage 1: ingest (integration, mocked APIs)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  async function ingest() {
    return runIngest(db, silentLogger, {
      channelUrl: 'https://www.youtube.com/@indieappchannel',
      youtubeApiKey: 'test-key',
      maxVideos: 100,
      fetchFn: mockYouTubeFetch(),
      fetchTranscript: mockTranscripts,
    });
  }

  it('ingests videos with correct per-video transcript status and never halts the batch', async () => {
    const result = await ingest();

    expect(result.channelName).toBe('Indie App Channel');
    expect(result.videosListed).toBe(3);
    expect(result.transcripts).toEqual({ ok: 1, unavailable: 1, error: 1 });

    const rows = db.prepare('SELECT video_id, transcript_status, transcript_text FROM videos ORDER BY video_id').all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ video_id: 'vid-1', transcript_status: 'ok' });
    expect(rows[0].transcript_text).toContain('FocusKit');
    expect(rows[1]).toMatchObject({ video_id: 'vid-2', transcript_status: 'unavailable', transcript_text: null });
    expect(rows[2]).toMatchObject({ video_id: 'vid-3', transcript_status: 'error', transcript_text: null });
  }, 30_000);

  it('is idempotent: re-running skips ok videos and creates no duplicate rows', async () => {
    await ingest();
    const second = await ingest();

    expect(second.videosSkipped).toBe(1); // vid-1 already ok
    expect((db.prepare('SELECT COUNT(*) AS n FROM videos').get() as any).n).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS n FROM channels').get() as any).n).toBe(1);
  }, 30_000);

  it('respects the MAX_VIDEOS cap', async () => {
    const result = await runIngest(db, silentLogger, {
      channelUrl: 'https://www.youtube.com/channel/UCfixture123',
      youtubeApiKey: 'test-key',
      maxVideos: 2,
      fetchFn: mockYouTubeFetch(),
      fetchTranscript: mockTranscripts,
    });
    expect(result.videosListed).toBe(2);
  }, 30_000);
});
