import { beforeEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { normalizeAppName, openDb } from '../src/db.js';
import { getPendingApps, runResearch, type ResearchClient, type ResearchOutput } from '../src/research.js';
import type { Logger } from '../src/logger.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  logFilePath: '/dev/null',
} as unknown as Logger;

function message(content: unknown[], stopReason: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 5000, output_tokens: 500 },
  } as Anthropic.Message;
}

const searchBlock = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'FocusKit app' } };

function recordResearchBlock(input: unknown) {
  return { type: 'tool_use', id: 'toolu_rr', name: 'record_research', input };
}

const completeOutput: ResearchOutput = {
  research_status: 'complete',
  app_exists: true,
  verified_revenue: '$38k MRR (June 2026)',
  revenue_source_url: 'https://indiehackers.com/focuskit',
  target_market: 'remote teams',
  pricing_model: '$12/mo subscription',
  launch_year: 2025,
  distribution_channel: 'SEO',
  success_factors: ['SEO content', 'TikTok clips'],
  sources: [
    { field: 'verified_revenue', url: 'https://indiehackers.com/focuskit' },
    { field: 'pricing_model', url: 'https://focuskit.example.com/pricing' },
  ],
  notes: null,
};

const notFoundOutput: ResearchOutput = {
  research_status: 'not_found',
  app_exists: false,
  verified_revenue: null,
  revenue_source_url: null,
  target_market: null,
  pricing_model: null,
  launch_year: null,
  distribution_channel: null,
  success_factors: null,
  sources: [],
  notes: 'unverified — claimed $40k MRR in video',
};

function fakeClient(responses: Anthropic.Message[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: ResearchClient = {
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

function seedApp(db: Database.Database, name: string, videoId: string): number {
  db.prepare(`INSERT INTO channels (channel_url, channel_name, video_count) VALUES ('u-' || ?, 'c', 1)`).run(videoId);
  const channelId = (db.prepare('SELECT MAX(id) AS id FROM channels').get() as any).id;
  db.prepare(
    `INSERT INTO videos (channel_id, video_id, title, published_at, transcript_status, transcript_text, extraction_status)
     VALUES (?, ?, 't', '2026-06-01', 'ok', 'x', 'done')`,
  ).run(channelId, videoId);
  const videoRowId = (db.prepare('SELECT id FROM videos WHERE video_id = ?').get(videoId) as any).id;
  db.prepare(
    `INSERT INTO apps (video_id, name, normalized_name, description, niche, claimed_revenue, founder, extraction_confidence)
     VALUES (?, ?, ?, 'desc', 'productivity', '$40k MRR', 'Maya Chen', 'high')`,
  ).run(videoRowId, name, normalizeAppName(name));
  return (db.prepare('SELECT MAX(id) AS id FROM apps').get() as any).id;
}

describe('stage 3: research (integration, mocked Anthropic API)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('runs the agent loop through pause_turn, counts searches, and stores validated findings', async () => {
    const appId = seedApp(db, 'FocusKit', 'vid-1');
    const { client, requests } = fakeClient([
      message([searchBlock, searchBlock], 'pause_turn'),
      message([searchBlock, recordResearchBlock(completeOutput)], 'tool_use'),
    ]);

    const result = await runResearch(db, silentLogger, { anthropicApiKey: 'test', maxIterations: 8, client });

    expect(result).toMatchObject({ appsResearched: 1, appsFailed: 0, searchesUsed: 3 });
    expect(result.statusCounts).toEqual({ complete: 1 });

    // Request shape: sonnet, web_search capped at maxIterations, checklist in system prompt
    const first = requests[0]!;
    expect(first.model).toBe('claude-sonnet-4-6');
    expect(first.tools).toContainEqual({ type: 'web_search_20260209', name: 'web_search', max_uses: 8 });
    expect(JSON.stringify(first.system)).toContain('at most 8 web searches');
    // pause_turn continuation resends assistant content without adding a user turn
    expect(requests[1]!.messages.at(-1)?.role).toBe('assistant');

    const row = db.prepare('SELECT * FROM research WHERE app_id = ?').get(appId) as any;
    expect(row).toMatchObject({
      research_status: 'complete',
      verified_revenue: '$38k MRR (June 2026)',
      revenue_source_url: 'https://indiehackers.com/focuskit',
      launch_year: 2025,
    });
    expect(JSON.parse(row.success_factors)).toEqual(['SEO content', 'TikTok clips']);
    expect(JSON.parse(row.sources_json).sources).toHaveLength(2);
  });

  it('records not_found with the unverified-claim note preserved', async () => {
    const appId = seedApp(db, 'GhostApp', 'vid-1');
    const { client } = fakeClient([
      message([searchBlock, searchBlock, searchBlock, recordResearchBlock(notFoundOutput)], 'tool_use'),
    ]);

    const result = await runResearch(db, silentLogger, { anthropicApiKey: 'test', maxIterations: 8, client });

    expect(result.statusCounts).toEqual({ not_found: 1 });
    const row = db.prepare('SELECT * FROM research WHERE app_id = ?').get(appId) as any;
    expect(row.research_status).toBe('not_found');
    expect(row.verified_revenue).toBeNull();
    expect(JSON.parse(row.sources_json).notes).toContain('unverified');
  });

  it('dedupes apps by normalized name before research and is resumable', async () => {
    const firstId = seedApp(db, 'FocusKit', 'vid-1');
    seedApp(db, 'Focus Kit', 'vid-2'); // same normalized name, different video

    expect(getPendingApps(db)).toHaveLength(1);

    const { client, requests } = fakeClient([
      message([recordResearchBlock(completeOutput)], 'tool_use'),
      message([recordResearchBlock(completeOutput)], 'tool_use'),
    ]);
    await runResearch(db, silentLogger, { anthropicApiKey: 'test', maxIterations: 8, client });
    const second = await runResearch(db, silentLogger, { anthropicApiKey: 'test', maxIterations: 8, client });

    expect(requests).toHaveLength(1); // one research run covers both duplicate rows
    expect(second.appsResearched).toBe(0); // resumable: nothing pending on re-run
    const rows = db.prepare('SELECT app_id FROM research').all() as any[];
    expect(rows).toEqual([{ app_id: firstId }]);
    // The duplicate's brief mentions both videos
    expect(JSON.stringify(requests[0]!.messages[0])).toContain('2 video(s)');
  });

  it('retries once on schema validation failure with the error appended', async () => {
    seedApp(db, 'FocusKit', 'vid-1');
    const invalid = { ...completeOutput, research_status: 'finished' };
    const { client, requests } = fakeClient([
      message([recordResearchBlock(invalid)], 'tool_use'),
      message([recordResearchBlock(completeOutput)], 'tool_use'),
    ]);

    const result = await runResearch(db, silentLogger, { anthropicApiKey: 'test', maxIterations: 8, client });

    expect(result.appsResearched).toBe(1);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain('failed schema validation');
  });

  it('nudges when the model ends without recording, and a failing app never halts the batch', async () => {
    seedApp(db, 'FirstApp', 'vid-1');
    seedApp(db, 'SecondApp', 'vid-2');
    const { client, requests } = fakeClient([
      // FirstApp: ends without tool call twice, then still nothing -> gives up (stays pending)
      message([{ type: 'text', text: 'I looked around.' }], 'end_turn'),
      message([{ type: 'text', text: 'Done I think.' }], 'end_turn'),
      message([{ type: 'text', text: 'Nothing to record.' }], 'end_turn'),
      // SecondApp: succeeds
      message([recordResearchBlock(completeOutput)], 'tool_use'),
    ]);

    const result = await runResearch(db, silentLogger, { anthropicApiKey: 'test', maxIterations: 8, client });

    expect(result).toMatchObject({ appsResearched: 1, appsFailed: 1 });
    // The nudge instruction was sent
    expect(JSON.stringify(requests[1]!.messages)).toContain('Call record_research now');
    // Failed app left pending for a resumed run
    expect(getPendingApps(db).map((a) => a.name)).toEqual(['FirstApp']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM research').get() as any).n).toBe(1);
  });
});
