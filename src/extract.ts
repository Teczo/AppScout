import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { normalizeAppName } from './db.js';
import type { Logger } from './logger.js';

export const EXTRACTION_MODEL = 'claude-haiku-4-5';
const TRANSCRIPT_CHAR_LIMIT = 50_000;

const ExtractedAppSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable(),
  niche: z.string().nullable(),
  claimed_revenue: z.string().nullable(),
  founder: z.string().nullable(),
  extraction_confidence: z.enum(['high', 'medium', 'low']),
});
const RecordAppsSchema = z.object({
  apps: z.array(ExtractedAppSchema),
});
export type ExtractedApp = z.infer<typeof ExtractedAppSchema>;

const RECORD_APPS_TOOL: Anthropic.Tool = {
  name: 'record_apps',
  description:
    'Record every distinct app/product discussed in the video transcript. Call with an empty apps array if the video discusses no specific app.',
  input_schema: {
    type: 'object',
    properties: {
      apps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The app/product name' },
            description: { type: ['string', 'null'], description: 'One-sentence description of what the app does' },
            niche: { type: ['string', 'null'], description: 'Market niche/category, e.g. "AI writing tools"' },
            claimed_revenue: {
              type: ['string', 'null'],
              description: 'Revenue figure exactly as claimed in the video, verbatim (e.g. "$40k MRR"). Null if none stated.',
            },
            founder: { type: ['string', 'null'], description: 'Founder name if mentioned' },
            extraction_confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'How confident you are this is a real, distinct app discussed in the video',
            },
          },
          required: ['name', 'description', 'niche', 'claimed_revenue', 'founder', 'extraction_confidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['apps'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You extract structured data about apps from YouTube video transcripts.

The transcripts come from channels that discuss indie apps, SaaS products, and startups. For the transcript you are given:

- Identify every distinct app or software product that is actually discussed (not merely name-dropped in passing as a comparison or sponsor).
- Record each one with the record_apps tool.
- If the video discusses no specific app or product, call record_apps with an empty apps array.
- claimed_revenue must contain revenue figures exactly as claimed in the video, verbatim (e.g. "$40k MRR", "seven figures a year"). Do not convert or normalize them. Null if no figure is stated.
- Only include information stated in the transcript. Never fill gaps from prior knowledge. Use null for anything not mentioned.
- Set extraction_confidence: high = clearly a real app discussed at length; medium = discussed briefly or ambiguously; low = uncertain it is a distinct app.`;

/** Minimal client surface so tests can inject a fake. */
export interface ExtractClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface ExtractResult {
  videosProcessed: number;
  videosFailed: number;
  appsExtracted: number;
  usage: { inputTokens: number; outputTokens: number };
}

interface PendingVideo {
  id: number;
  video_id: string;
  title: string;
  transcript_text: string;
}

/**
 * Stage 2: one Claude call per transcript, JSON forced via the record_apps
 * tool, Zod-validated. On validation failure retries once with the error
 * appended; on second failure marks the video extraction-failed and continues.
 * Resumable: only processes videos with extraction_status='pending' and an ok
 * transcript.
 */
export async function runExtract(
  db: Database.Database,
  logger: Logger,
  opts: { anthropicApiKey: string; client?: ExtractClient },
): Promise<ExtractResult> {
  const client =
    opts.client ?? new Anthropic({ apiKey: opts.anthropicApiKey, maxRetries: 3 });

  const pending = db
    .prepare(
      `SELECT id, video_id, title, transcript_text FROM videos
       WHERE transcript_status = 'ok' AND extraction_status = 'pending'`,
    )
    .all() as PendingVideo[];

  logger.info(`Extract: ${pending.length} videos pending (model ${EXTRACTION_MODEL})`);

  const insertApp = db.prepare(
    `INSERT INTO apps (video_id, name, normalized_name, description, niche, claimed_revenue, founder, extraction_confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const setStatus = db.prepare('UPDATE videos SET extraction_status = ? WHERE id = ?');

  const result: ExtractResult = {
    videosProcessed: 0,
    videosFailed: 0,
    appsExtracted: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  for (const video of pending) {
    const transcript = video.transcript_text.slice(0, TRANSCRIPT_CHAR_LIMIT);
    try {
      const apps = await extractFromTranscript(client, transcript, result.usage);
      const insertAll = db.transaction((rows: ExtractedApp[]) => {
        for (const app of rows) {
          insertApp.run(
            video.id,
            app.name,
            normalizeAppName(app.name),
            app.description,
            app.niche,
            app.claimed_revenue,
            app.founder,
            app.extraction_confidence,
          );
        }
        setStatus.run('done', video.id);
      });
      insertAll(apps);
      result.videosProcessed++;
      result.appsExtracted += apps.length;
      logger.info(`Extract: ${video.video_id} -> ${apps.length} app(s)`);
    } catch (err) {
      // One failing video never halts the batch.
      result.videosFailed++;
      setStatus.run('failed', video.id);
      logger.error(`Extract: failed for ${video.video_id} ("${video.title}"): ${String(err).slice(0, 300)}`);
    }
  }

  logger.info(
    `Extract: done. processed=${result.videosProcessed} failed=${result.videosFailed} apps=${result.appsExtracted} ` +
      `tokens in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
  );
  return result;
}

/** One extraction call; on Zod failure, one retry with the validation error appended. */
async function extractFromTranscript(
  client: ExtractClient,
  transcript: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<ExtractedApp[]> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `Extract all apps from this video transcript:\n\n<transcript>\n${transcript}\n</transcript>` },
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [RECORD_APPS_TOOL],
      tool_choice: { type: 'tool', name: 'record_apps' },
      messages,
    });
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_apps',
    );
    if (!toolUse) {
      throw new Error(`No record_apps tool call in response (stop_reason=${response.stop_reason})`);
    }

    const parsed = RecordAppsSchema.safeParse(toolUse.input);
    if (parsed.success) return parsed.data.apps;

    if (attempt === 2) {
      throw new Error(`Schema validation failed after retry: ${parsed.error.message.slice(0, 500)}`);
    }
    // Retry once with the validation error appended.
    messages.push(
      { role: 'assistant', content: response.content },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            is_error: true,
            content: `Your record_apps input failed schema validation:\n${parsed.error.message}\nCall record_apps again with valid input.`,
          },
        ],
      },
    );
  }
  throw new Error('unreachable');
}
