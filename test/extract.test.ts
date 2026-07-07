import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { runExtract, type ExtractClient } from '../src/extract.js';
import type { Logger } from '../src/logger.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  logFilePath: '/dev/null',
} as unknown as Logger;

const fixtureTranscript = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'transcript-focuskit.txt'),
  'utf8',
);

function toolUseMessage(input: unknown): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'tool_use', id: 'toolu_test', name: 'record_apps', input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200 } as Anthropic.Usage,
  } as Anthropic.Message;
}

const validApps = {
  apps: [
    {
      name: 'FocusKit',
      description: 'Pomodoro timer for remote teams',
      niche: 'productivity',
      claimed_revenue: '$40k MRR',
      founder: 'Maya Chen',
      extraction_confidence: 'high',
    },
    {
      name: 'Invoice Owl',
      description: 'Invoicing tool for freelance designers',
      niche: 'invoicing',
      claimed_revenue: 'seven figures a year',
      founder: null,
      extraction_confidence: 'medium',
    },
  ],
};

/** Fake client that pops queued responses and records requests. */
function fakeClient(responses: Anthropic.Message[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: ExtractClient = {
    messages: {
      create: async (params) => {
        requests.push(params);
        const next = responses.shift();
        if (!next) throw new Error('fake client ran out of responses');
        return next;
      },
    },
  };
  return { client, requests };
}

function seedVideo(db: Database.Database, videoId: string, transcript: string | null, status = 'ok'): number {
  db.prepare(
    `INSERT INTO channels (channel_url, channel_name, video_count) VALUES ('u-' || ?, 'c', 1)`,
  ).run(videoId);
  const channelId = (db.prepare('SELECT MAX(id) AS id FROM channels').get() as any).id;
  db.prepare(
    `INSERT INTO videos (channel_id, video_id, title, published_at, transcript_status, transcript_text)
     VALUES (?, ?, 'title', '2026-06-01', ?, ?)`,
  ).run(channelId, videoId, status, transcript);
  return (db.prepare('SELECT id FROM videos WHERE video_id = ?').get(videoId) as any).id;
}

describe('stage 2: extract (integration, mocked Anthropic API)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('extracts apps from a fixture transcript into the apps table with normalized names', async () => {
    seedVideo(db, 'vid-1', fixtureTranscript);
    const { client, requests } = fakeClient([toolUseMessage(validApps)]);

    const result = await runExtract(db, silentLogger, { anthropicApiKey: 'test', client });

    expect(result).toMatchObject({ videosProcessed: 1, videosFailed: 0, appsExtracted: 2 });
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200 });

    // Request shape: haiku model, forced tool choice, transcript in the user message
    expect(requests[0]!.model).toBe('claude-haiku-4-5');
    expect(requests[0]!.tool_choice).toEqual({ type: 'tool', name: 'record_apps' });
    expect(JSON.stringify(requests[0]!.messages)).toContain('FocusKit');

    const rows = db.prepare('SELECT * FROM apps ORDER BY id').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'FocusKit', normalized_name: 'focuskit', claimed_revenue: '$40k MRR' });
    expect(rows[1]).toMatchObject({ name: 'Invoice Owl', normalized_name: 'invoiceowl', founder: null });

    const video = db.prepare("SELECT extraction_status FROM videos WHERE video_id = 'vid-1'").get() as any;
    expect(video.extraction_status).toBe('done');
  });

  it('retries once with the validation error appended, then succeeds', async () => {
    seedVideo(db, 'vid-1', fixtureTranscript);
    const invalid = { apps: [{ name: 'FocusKit', extraction_confidence: 'very high' }] };
    const { client, requests } = fakeClient([toolUseMessage(invalid), toolUseMessage(validApps)]);

    const result = await runExtract(db, silentLogger, { anthropicApiKey: 'test', client });

    expect(result.videosProcessed).toBe(1);
    expect(requests).toHaveLength(2);
    // Second request carries the assistant turn + validation error as a tool_result
    const secondMessages = JSON.stringify(requests[1]!.messages);
    expect(secondMessages).toContain('failed schema validation');
  });

  it('marks the video extraction-failed after two invalid responses and continues the batch', async () => {
    seedVideo(db, 'vid-bad', fixtureTranscript);
    seedVideo(db, 'vid-good', fixtureTranscript);
    const invalid = { apps: [{ nope: true }] };
    const { client } = fakeClient([
      toolUseMessage(invalid),
      toolUseMessage(invalid),
      toolUseMessage({ apps: [] }),
    ]);

    const result = await runExtract(db, silentLogger, { anthropicApiKey: 'test', client });

    expect(result).toMatchObject({ videosProcessed: 1, videosFailed: 1, appsExtracted: 0 });
    const statuses = db
      .prepare('SELECT video_id, extraction_status FROM videos ORDER BY video_id')
      .all() as any[];
    expect(statuses).toEqual([
      { video_id: 'vid-bad', extraction_status: 'failed' },
      { video_id: 'vid-good', extraction_status: 'done' },
    ]);
  });

  it('is resumable: only pending videos with ok transcripts are processed', async () => {
    seedVideo(db, 'vid-1', fixtureTranscript);
    seedVideo(db, 'vid-2', null, 'unavailable');
    const { client, requests } = fakeClient([toolUseMessage(validApps), toolUseMessage(validApps)]);

    await runExtract(db, silentLogger, { anthropicApiKey: 'test', client });
    const second = await runExtract(db, silentLogger, { anthropicApiKey: 'test', client });

    expect(requests).toHaveLength(1); // vid-2 never sent; vid-1 not re-sent
    expect(second.videosProcessed).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM apps').get() as any).n).toBe(2);
  });

  it('truncates transcripts over 50k characters', async () => {
    seedVideo(db, 'vid-long', 'word '.repeat(20_000)); // 100k chars
    const { client, requests } = fakeClient([toolUseMessage({ apps: [] })]);

    await runExtract(db, silentLogger, { anthropicApiKey: 'test', client });

    const userContent = JSON.stringify(requests[0]!.messages[0]);
    expect(userContent.length).toBeLessThan(51_000 + 500); // 50k transcript + wrapper text
  });
});
