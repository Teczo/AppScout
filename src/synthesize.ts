import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from './logger.js';

export const SYNTHESIS_MODEL = 'claude-sonnet-4-6';

const ReportSchema = z.object({
  trends_md: z.string().min(1),
  ideas_md: z.string().min(1),
});
export type ReportOutput = z.infer<typeof ReportSchema>;

const RECORD_REPORT_TOOL: Anthropic.Tool = {
  name: 'record_report',
  description: 'Record the final synthesis report as two markdown sections.',
  input_schema: {
    type: 'object',
    properties: {
      trends_md: {
        type: 'string',
        description:
          'Markdown for the Trends section: patterns across niche, revenue band, pricing, distribution, founder type, time-to-revenue. Every pattern must cite specific apps from the data as evidence.',
      },
      ideas_md: {
        type: 'string',
        description:
          'Markdown for the Ideas section: 3-5 new app ideas, each justified by the identified trends, with target market and suggested distribution channel.',
      },
    },
    required: ['trends_md', 'ideas_md'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You synthesize research about apps featured on a YouTube channel into a trends report.

You receive the full research corpus as JSON: one entry per app with extraction data from the videos (claimed revenue, niche) and verified research findings (revenue, target market, pricing, launch year, distribution channel, success factors, sources, research status).

Produce two markdown sections via the record_report tool:

1. trends_md — patterns across niche, revenue band, pricing model, distribution channel, founder type, and time-to-revenue. Every pattern must reference specific apps from the corpus as evidence. Treat verified and merely-claimed revenue differently and say which is which. Ignore not_found apps except as a signal (e.g. hype without substance).

2. ideas_md — 3 to 5 new app ideas. Each idea must be justified by the trends you identified (cite them), with a target market and a suggested distribution channel. Ground every idea in the data — no generic ideas that could be written without this corpus.

Use only the provided data. Do not invent apps, figures, or sources.`;

/** Minimal client surface so tests can inject a fake. */
export interface SynthesizeClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface SynthesizeResult {
  reportId: number | null;
  reportPath: string | null;
  skipped: boolean;
  appsInCorpus: number;
  usage: { inputTokens: number; outputTokens: number };
}

interface ChannelRowLite {
  id: number;
  channel_name: string;
}

/** Research corpus for one channel: research rows joined with their app rows. */
function getCorpus(db: Database.Database, channelId: number): Record<string, unknown>[] {
  const rows = db
    .prepare(
      `SELECT a.name, a.description, a.niche, a.claimed_revenue, a.founder, a.extraction_confidence,
              r.verified_revenue, r.revenue_source_url, r.target_market, r.pricing_model,
              r.launch_year, r.distribution_channel, r.success_factors, r.research_status, r.sources_json
       FROM research r
       JOIN apps a ON a.id = r.app_id
       JOIN videos v ON v.id = a.video_id
       WHERE v.channel_id = ?
       ORDER BY a.name`,
    )
    .all(channelId) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...row,
    success_factors: row.success_factors ? JSON.parse(row.success_factors as string) : null,
    sources_json: row.sources_json ? JSON.parse(row.sources_json as string) : null,
  }));
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'channel';
}

/**
 * Stage 4: one Claude call over all research rows for the channel (context
 * stuffing — no RAG). Output validated with Zod (one retry), stored in
 * reports, and written to {outputDir}/report-{channel}-{date}.md.
 * Idempotent: skips when a report already covers the latest research.
 */
export async function runSynthesize(
  db: Database.Database,
  logger: Logger,
  opts: {
    anthropicApiKey: string;
    channelUrl: string;
    outputDir?: string;
    client?: SynthesizeClient;
  },
): Promise<SynthesizeResult> {
  const outputDir = opts.outputDir ?? './output';
  const channel = db
    .prepare('SELECT id, channel_name FROM channels WHERE channel_url = ?')
    .get(opts.channelUrl) as ChannelRowLite | undefined;
  if (!channel) {
    throw new Error(`Channel not found in DB for URL ${opts.channelUrl} — run the ingest stage first.`);
  }

  const corpus = getCorpus(db, channel.id);
  const result: SynthesizeResult = {
    reportId: null,
    reportPath: null,
    skipped: false,
    appsInCorpus: corpus.length,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  if (corpus.length === 0) {
    throw new Error('No research rows for this channel — run the research stage first.');
  }

  // Idempotency: skip if the newest report already covers the newest research.
  const upToDate = db
    .prepare(
      `SELECT 1 FROM reports
       WHERE channel_id = ?
         AND created_at >= (SELECT MAX(r.researched_at) FROM research r
                            JOIN apps a ON a.id = r.app_id
                            JOIN videos v ON v.id = a.video_id
                            WHERE v.channel_id = ?)`,
    )
    .get(channel.id, channel.id);
  if (upToDate) {
    logger.info('Synthesize: report already up to date with latest research; skipping.');
    result.skipped = true;
    return result;
  }

  logger.info(`Synthesize: ${corpus.length} researched apps in corpus (model ${SYNTHESIS_MODEL})`);
  const client =
    opts.client ?? new Anthropic({ apiKey: opts.anthropicApiKey, maxRetries: 3 });
  const report = await synthesizeReport(client, corpus, result.usage);

  const insert = db
    .prepare('INSERT INTO reports (channel_id, trends_md, ideas_md) VALUES (?, ?, ?)')
    .run(channel.id, report.trends_md, report.ideas_md);
  result.reportId = Number(insert.lastInsertRowid);

  fs.mkdirSync(outputDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  result.reportPath = path.join(outputDir, `report-${slugify(channel.channel_name)}-${date}.md`);
  fs.writeFileSync(
    result.reportPath,
    `# AppScout Report — ${channel.channel_name} (${date})\n\n` +
      `_${corpus.length} researched apps._\n\n## Trends\n\n${report.trends_md}\n\n## Ideas\n\n${report.ideas_md}\n`,
  );

  logger.info(
    `Synthesize: done. report id=${result.reportId} path=${result.reportPath} ` +
      `tokens in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
  );
  return result;
}

/** Single synthesis call; one retry with the validation error appended. */
export async function synthesizeReport(
  client: SynthesizeClient,
  corpus: Record<string, unknown>[],
  usage: { inputTokens: number; outputTokens: number },
): Promise<ReportOutput> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Synthesize the trends report from this research corpus:\n\n<research_corpus>\n${JSON.stringify(corpus, null, 1)}\n</research_corpus>`,
    },
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await client.messages.create({
      model: SYNTHESIS_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: [RECORD_REPORT_TOOL],
      tool_choice: { type: 'tool', name: 'record_report' },
      messages,
    });
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_report',
    );
    if (!toolUse) {
      throw new Error(`No record_report tool call in response (stop_reason=${response.stop_reason})`);
    }

    const parsed = ReportSchema.safeParse(toolUse.input);
    if (parsed.success) return parsed.data;
    if (attempt === 2) {
      throw new Error(`Report failed schema validation after retry: ${parsed.error.message.slice(0, 400)}`);
    }
    messages.push(
      { role: 'assistant', content: response.content },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            is_error: true,
            content: `Your record_report input failed schema validation:\n${parsed.error.message}\nCall record_report again with valid input.`,
          },
        ],
      },
    );
  }
  throw new Error('unreachable');
}
