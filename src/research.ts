import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Logger } from './logger.js';

export const RESEARCH_MODEL = 'claude-sonnet-4-6';

/** Rough per-app cost model for the pre-run estimate (searches + tokens). */
const COST_PER_SEARCH_USD = 0.01; // $10 per 1000 searches
const EST_TOKEN_COST_PER_APP_USD = 0.11; // ~25k in @ $3/MTok + ~2.5k out @ $15/MTok

const ResearchOutputSchema = z.object({
  research_status: z.enum(['complete', 'partial', 'not_found']),
  app_exists: z.boolean(),
  verified_revenue: z.string().nullable(),
  revenue_source_url: z.string().nullable(),
  target_market: z.string().nullable(),
  pricing_model: z.string().nullable(),
  launch_year: z.number().int().nullable(),
  distribution_channel: z.string().nullable(),
  success_factors: z.array(z.string()).max(3).nullable(),
  sources: z.array(z.object({ field: z.string(), url: z.string() })),
  notes: z.string().nullable(),
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

const RECORD_RESEARCH_TOOL: Anthropic.Tool = {
  name: 'record_research',
  description:
    'Record the final research findings for the app. Call this exactly once, when the checklist is answered or you must stop (cap reached / app not found).',
  input_schema: {
    type: 'object',
    properties: {
      research_status: {
        type: 'string',
        enum: ['complete', 'partial', 'not_found'],
        description:
          'complete = all checklist items answered with sources; partial = some answered; not_found = could not confirm the app exists',
      },
      app_exists: { type: 'boolean', description: 'Whether you confirmed the app exists (official site / app store listing)' },
      verified_revenue: {
        type: ['string', 'null'],
        description:
          'Revenue (MRR/ARR) verified by an independent source (founder post, Indie Hackers, press). Null if no independent source found — never copy the video claim here.',
      },
      revenue_source_url: { type: ['string', 'null'], description: 'URL of the independent revenue source. Required if verified_revenue is set.' },
      target_market: { type: ['string', 'null'], description: 'Target market / customer profile' },
      pricing_model: { type: ['string', 'null'], description: 'e.g. freemium, $19/mo subscription, one-time purchase' },
      launch_year: { type: ['integer', 'null'], description: 'Year the app launched' },
      distribution_channel: { type: ['string', 'null'], description: 'Primary distribution channel (SEO, TikTok, Product Hunt, ...)' },
      success_factors: {
        type: ['array', 'null'],
        items: { type: 'string' },
        maxItems: 3,
        description: '2-3 stated success factors, from sources',
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'Which field this source supports, e.g. "pricing_model"' },
            url: { type: 'string' },
          },
          required: ['field', 'url'],
          additionalProperties: false,
        },
        description: 'One entry per non-null factual field. A field without a source must be null.',
      },
      notes: {
        type: ['string', 'null'],
        description: 'Caveats, e.g. \'unverified — claimed $40k MRR in video\' when no independent revenue source was found.',
      },
    },
    required: [
      'research_status',
      'app_exists',
      'verified_revenue',
      'revenue_source_url',
      'target_market',
      'pricing_model',
      'launch_year',
      'distribution_channel',
      'success_factors',
      'sources',
      'notes',
    ],
    additionalProperties: false,
  },
};

function systemPrompt(maxIterations: number): string {
  return `You are a research agent verifying facts about an app mentioned in a YouTube video. Use the web_search tool to work through this checklist:

1. Confirm the app exists (official site / app store listing)
2. Verified revenue (MRR/ARR) with a source URL — founder posts, Indie Hackers, press
3. Target market / customer profile
4. Pricing model
5. Launch year
6. Primary distribution channel (SEO, TikTok, Product Hunt, etc.)
7. 2-3 stated success factors

Rules (mandatory):
- You have at most ${maxIterations} web searches. If all checklist items are answered, call record_research immediately — do not keep searching.
- If after 3 searches nothing confirms the app exists, stop and call record_research with research_status='not_found'. Do not keep reformulating queries.
- Distinguish claimed vs verified revenue. The video's claim is NOT verification. If no independent source confirms revenue, set verified_revenue=null and put "unverified — claimed <figure> in video" in notes.
- Every non-null factual field must have a matching entry in sources with a real URL you actually saw. No source -> set the field to null. Never fill gaps from your prior knowledge.
- Finish by calling record_research exactly once.`;
}

/** Minimal client surface so tests can inject a fake. */
export interface ResearchClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

interface AppToResearch {
  id: number;
  name: string;
  description: string | null;
  niche: string | null;
  claimed_revenue: string | null;
  founder: string | null;
  video_count: number;
}

export interface ResearchResult {
  appsResearched: number;
  appsFailed: number;
  statusCounts: Record<string, number>;
  searchesUsed: number;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Apps pending research: one canonical row per normalized_name (lowest id),
 * excluding names that already have a research row. Dedup happens here, per
 * spec, before any research runs.
 */
export function getPendingApps(db: Database.Database): AppToResearch[] {
  return db
    .prepare(
      `SELECT MIN(a.id) AS id, a.name, a.description, a.niche, a.claimed_revenue, a.founder,
              COUNT(*) AS video_count
       FROM apps a
       WHERE a.normalized_name NOT IN (
         SELECT a2.normalized_name FROM apps a2 JOIN research r ON r.app_id = a2.id
       )
       GROUP BY a.normalized_name`,
    )
    .all() as AppToResearch[];
}

export function estimateResearchCostUsd(appCount: number, maxIterations: number): number {
  return appCount * (maxIterations * COST_PER_SEARCH_USD + EST_TOKEN_COST_PER_APP_USD);
}

/**
 * Stage 3: per-app agent loop with the Anthropic web search tool.
 * Sequential (spec allows up to 3 concurrent; sequential keeps rate limits
 * simple). One failing app never halts the batch — it is left pending for the
 * next resumable run.
 */
export async function runResearch(
  db: Database.Database,
  logger: Logger,
  opts: { anthropicApiKey: string; maxIterations: number; client?: ResearchClient },
): Promise<ResearchResult> {
  const client =
    opts.client ?? new Anthropic({ apiKey: opts.anthropicApiKey, maxRetries: 3 });

  const pending = getPendingApps(db);
  logger.info(`Research: ${pending.length} unique apps pending (model ${RESEARCH_MODEL}, cap ${opts.maxIterations} searches/app)`);

  const insert = db.prepare(
    `INSERT INTO research (app_id, verified_revenue, revenue_source_url, target_market, pricing_model,
                           launch_year, distribution_channel, success_factors, research_status, sources_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const result: ResearchResult = {
    appsResearched: 0,
    appsFailed: 0,
    statusCounts: {},
    searchesUsed: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  for (const app of pending) {
    try {
      const { output, searches } = await researchApp(client, app, opts.maxIterations, result.usage, logger);
      result.searchesUsed += searches;
      insert.run(
        app.id,
        output.verified_revenue,
        output.revenue_source_url,
        output.target_market,
        output.pricing_model,
        output.launch_year,
        output.distribution_channel,
        output.success_factors ? JSON.stringify(output.success_factors) : null,
        output.research_status,
        JSON.stringify({ sources: output.sources, notes: output.notes }),
      );
      result.appsResearched++;
      result.statusCounts[output.research_status] = (result.statusCounts[output.research_status] ?? 0) + 1;
      logger.info(`Research: "${app.name}" -> ${output.research_status} (${searches} searches)`);
    } catch (err) {
      // Leave the app pending so a resumed run retries it; never halt the batch.
      result.appsFailed++;
      logger.error(`Research: failed for "${app.name}": ${String(err).slice(0, 300)}`);
    }
  }

  logger.info(
    `Research: done. researched=${result.appsResearched} failed=${result.appsFailed} ` +
      `statuses=${JSON.stringify(result.statusCounts)} searches=${result.searchesUsed} ` +
      `tokens in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
  );
  return result;
}

/** Agent loop for one app. Returns validated output plus the number of searches used. */
async function researchApp(
  client: ResearchClient,
  app: AppToResearch,
  maxIterations: number,
  usage: { inputTokens: number; outputTokens: number },
  logger: Logger,
): Promise<{ output: ResearchOutput; searches: number }> {
  const tools: Anthropic.MessageCreateParamsNonStreaming['tools'] = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: maxIterations },
    RECORD_RESEARCH_TOOL,
  ];

  const appBrief = [
    `App name: ${app.name}`,
    app.description ? `Description (from video): ${app.description}` : null,
    app.niche ? `Niche: ${app.niche}` : null,
    app.claimed_revenue ? `Revenue claimed in video: ${app.claimed_revenue}` : null,
    app.founder ? `Founder (from video): ${app.founder}` : null,
    `Mentioned in ${app.video_count} video(s).`,
  ]
    .filter(Boolean)
    .join('\n');

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `Research this app:\n\n${appBrief}` },
  ];

  let searches = 0;
  let validationRetried = false;
  let nudges = 0;
  // Continuation ceiling: pause_turns + validation retry + nudges, bounded.
  const maxCalls = maxIterations + 6;

  for (let call = 0; call < maxCalls; call++) {
    const response = await client.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: systemPrompt(maxIterations),
      tools,
      messages,
    });
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    searches += response.content.filter(
      (b) => b.type === 'server_tool_use' && b.name === 'web_search',
    ).length;

    // Server-side tool loop paused — append and continue as-is.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_research',
    );

    if (toolUse) {
      const parsed = ResearchOutputSchema.safeParse(toolUse.input);
      if (parsed.success) return { output: parsed.data, searches };
      if (validationRetried) {
        throw new Error(`record_research failed validation after retry: ${parsed.error.message.slice(0, 400)}`);
      }
      validationRetried = true;
      messages.push(
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              is_error: true,
              content: `Your record_research input failed schema validation:\n${parsed.error.message}\nCall record_research again with valid input.`,
            },
          ],
        },
      );
      continue;
    }

    // Ended without recording findings — nudge (max 2), then give up on this app.
    if (nudges >= 2) break;
    nudges++;
    logger.warn(`Research: "${app.name}" ended turn without record_research; nudging (${nudges}/2)`);
    messages.push(
      { role: 'assistant', content: response.content },
      {
        role: 'user',
        content:
          'Stop searching. Call record_research now with everything found so far (use research_status="partial" if the checklist is incomplete, or "not_found" if the app could not be confirmed).',
      },
    );
  }

  throw new Error(`agent loop exhausted ${maxCalls} calls without a valid record_research output`);
}
