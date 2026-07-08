import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { runSynthesize, type SynthesizeClient } from '../src/synthesize.js';
import type { Logger } from '../src/logger.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  logFilePath: '/dev/null',
} as unknown as Logger;

const CHANNEL_URL = 'https://www.youtube.com/@indieappchannel';

function reportMessage(input: unknown): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'tool_use', id: 'toolu_rep', name: 'record_report', input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 20000, output_tokens: 3000 },
  } as Anthropic.Message;
}

const validReport = {
  trends_md: '- Productivity apps dominate; FocusKit ($38k MRR verified) grew via SEO.',
  ideas_md: '1. Team standup timer — target: remote agencies; channel: SEO (per FocusKit trend).',
};

function fakeClient(responses: Anthropic.Message[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: SynthesizeClient = {
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

function seedResearchedApp(db: Database.Database): void {
  db.prepare(`INSERT INTO channels (channel_url, channel_name, video_count) VALUES (?, 'Indie App Channel', 1)`).run(CHANNEL_URL);
  db.prepare(
    `INSERT INTO videos (channel_id, video_id, title, published_at, transcript_status, transcript_text, extraction_status)
     VALUES (1, 'vid-1', 't', '2026-06-01', 'ok', 'x', 'done')`,
  ).run();
  db.prepare(
    `INSERT INTO apps (video_id, name, normalized_name, description, niche, claimed_revenue, founder, extraction_confidence)
     VALUES (1, 'FocusKit', 'focuskit', 'Pomodoro timer', 'productivity', '$40k MRR', 'Maya Chen', 'high')`,
  ).run();
  db.prepare(
    `INSERT INTO research (app_id, verified_revenue, revenue_source_url, target_market, pricing_model,
                           launch_year, distribution_channel, success_factors, research_status, sources_json)
     VALUES (1, '$38k MRR', 'https://indiehackers.com/focuskit', 'remote teams', '$12/mo', 2025, 'SEO',
             '["SEO content","TikTok clips"]', 'complete', '{"sources":[],"notes":null}')`,
  ).run();
}

describe('stage 4: synthesize (integration, mocked Anthropic API)', () => {
  let db: Database.Database;
  let outputDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appscout-test-'));
  });

  it('synthesizes the corpus into a stored report and a markdown file', async () => {
    seedResearchedApp(db);
    const { client, requests } = fakeClient([reportMessage(validReport)]);

    const result = await runSynthesize(db, silentLogger, {
      anthropicApiKey: 'test',
      channelUrl: CHANNEL_URL,
      outputDir,
      client,
    });

    expect(result.skipped).toBe(false);
    expect(result.appsInCorpus).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 20000, outputTokens: 3000 });

    // Single call, forced tool choice, full research corpus stuffed as JSON
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.model).toBe('claude-sonnet-4-6');
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'record_report' });
    const userContent = JSON.stringify(req.messages[0]);
    expect(userContent).toContain('FocusKit');
    expect(userContent).toContain('indiehackers.com');
    expect(userContent).toContain('$40k MRR'); // claimed
    expect(userContent).toContain('$38k MRR'); // verified

    // Stored in reports
    const row = db.prepare('SELECT * FROM reports').get() as any;
    expect(row).toMatchObject({ channel_id: 1, trends_md: validReport.trends_md, ideas_md: validReport.ideas_md });

    // Written to output/report-{channel}-{date}.md
    expect(result.reportPath).toMatch(/report-indie-app-channel-\d{4}-\d{2}-\d{2}\.md$/);
    const file = fs.readFileSync(result.reportPath!, 'utf8');
    expect(file).toContain('## Trends');
    expect(file).toContain('## Ideas');
    expect(file).toContain('FocusKit');
  });

  it('is idempotent: skips when a report already covers the latest research', async () => {
    seedResearchedApp(db);
    const { client, requests } = fakeClient([reportMessage(validReport), reportMessage(validReport)]);

    await runSynthesize(db, silentLogger, { anthropicApiKey: 'test', channelUrl: CHANNEL_URL, outputDir, client });
    const second = await runSynthesize(db, silentLogger, { anthropicApiKey: 'test', channelUrl: CHANNEL_URL, outputDir, client });

    expect(second.skipped).toBe(true);
    expect(requests).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM reports').get() as any).n).toBe(1);
  });

  it('retries once with the validation error appended', async () => {
    seedResearchedApp(db);
    const { client, requests } = fakeClient([
      reportMessage({ trends_md: 'only trends, no ideas' }),
      reportMessage(validReport),
    ]);

    const result = await runSynthesize(db, silentLogger, {
      anthropicApiKey: 'test',
      channelUrl: CHANNEL_URL,
      outputDir,
      client,
    });

    expect(result.reportId).not.toBeNull();
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain('failed schema validation');
  });

  it('fails clearly when there is no research for the channel', async () => {
    db.prepare(`INSERT INTO channels (channel_url, channel_name, video_count) VALUES (?, 'Empty', 0)`).run(CHANNEL_URL);
    const { client } = fakeClient([]);

    await expect(
      runSynthesize(db, silentLogger, { anthropicApiKey: 'test', channelUrl: CHANNEL_URL, outputDir, client }),
    ).rejects.toThrow(/No research rows/);
  });
});
