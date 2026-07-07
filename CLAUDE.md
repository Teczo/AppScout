# CLAUDE.md — App Trend Research Pipeline ("AppScout")

## Project Overview

AppScout ingests a YouTube channel URL, extracts every app discussed across the channel's videos, runs web research on each app (revenue, target market, success factors), synthesizes cross-app trends, and suggests new app ideas. Phase 1 is a CLI pipeline; Phase 2 wraps it in a Next.js web app with background jobs, a filterable results table, and a chat-with-findings feature.

**Current phase: Phase 1 (CLI pipeline). Do NOT build any web UI, API routes, or frontend code until Phase 1 is complete and explicitly approved.**

## Architecture

```
Channel URL
   │
   ▼
[1. INGEST]      YouTube Data API → video list → transcripts (deterministic, no LLM)
   │
   ▼
[2. EXTRACT]     One Claude call per transcript → structured JSON (app name, niche, claims)
   │
   ▼
[3. RESEARCH]    Agent loop per app: web search tool → verified MRR/ARR, market, pricing
   │
   ▼
[4. SYNTHESIZE]  One Claude call over all research → trends + idea suggestions
   │
   ▼
[5. OUTPUT]      SQLite DB + markdown report
```

Steps 1, 2, 4, 5 are deterministic pipelines. Only step 3 is agentic. Keep it that way — do not add agent loops where a single structured call suffices.

## Tech Stack

- **Runtime:** Node.js 20+, TypeScript, ESM modules
- **LLM:** Anthropic Messages API
  - Extraction (step 2): `claude-haiku-4-5` (cheap, high volume)
  - Research (step 3): `claude-sonnet-4-6` with web search tool
  - Synthesis (step 4): `claude-sonnet-4-6`
- **YouTube:** YouTube Data API v3 (video listing), `youtube-transcript` npm package (transcripts)
- **Storage:** SQLite via `better-sqlite3` (Phase 1). Migrate to Postgres only in Phase 2 if needed.
- **Validation:** Zod schemas for every LLM output. Reject and retry (max 2 retries) on schema failure.
- **No frameworks in Phase 1.** No LangChain, no LlamaIndex, no agent frameworks. Plain API calls in a loop. These add abstraction without value at this scale.

## Environment Variables

```
ANTHROPIC_API_KEY=      # required
YOUTUBE_API_KEY=        # required, Data API v3
MAX_VIDEOS=100          # hard cap per run
MAX_RESEARCH_ITERATIONS=8   # per app, hard cap on agent loop
DB_PATH=./data/appscout.db
```

Fail fast with a clear error message if a required env var is missing. Never hardcode keys.

## Data Models (SQLite)

```sql
-- channels: one row per ingested channel
channels(id, channel_url, channel_name, video_count, ingested_at)

-- videos: one row per video
videos(id, channel_id, video_id, title, published_at, transcript_status, transcript_text)
-- transcript_status: 'ok' | 'unavailable' | 'error'

-- apps: extracted apps (step 2 output)
apps(id, video_id, name, description, niche, claimed_revenue, founder, extraction_confidence)
-- extraction_confidence: 'high' | 'medium' | 'low'

-- research: verified findings (step 3 output)
research(id, app_id, verified_revenue, revenue_source_url, target_market,
         pricing_model, launch_year, distribution_channel, success_factors,
         research_status, sources_json, researched_at)
-- research_status: 'complete' | 'partial' | 'not_found'

-- reports: synthesis output (step 4)
reports(id, channel_id, trends_md, ideas_md, created_at)
```

Deduplicate apps by normalized name (lowercase, strip whitespace) before research — the same app may appear in multiple videos.

## Pipeline Stage Specs

### Stage 1 — Ingest

- Input: channel URL (handle formats: `/channel/UC...`, `/@handle`, `/c/name`).
- Resolve to channel ID, fetch uploads playlist, list videos (respect `MAX_VIDEOS`, newest first).
- Fetch transcript for each video. If unavailable (no captions), mark `transcript_status='unavailable'` and continue — do NOT attempt audio download or Whisper transcription. That is out of scope.
- Idempotent: re-running skips videos already in DB with `transcript_status='ok'`.

### Stage 2 — Extract

- One API call per transcript. Truncate transcripts over 50k characters (keep first 50k).
- System prompt instructs: extract every distinct app/product discussed; return JSON array matching the Zod schema; if the video discusses no specific app, return an empty array. Include any revenue figures *as claimed in the video* verbatim in `claimed_revenue`.
- Force JSON via tool-use (define a `record_apps` tool with the schema). Do not parse freeform text.
- On schema validation failure: retry once with the validation error appended. On second failure: log, mark video as extraction-failed, continue. Never halt the batch for one bad video.

### Stage 3 — Research (the agent)

Per app, run an agent loop with the Anthropic web search tool.

**Research checklist (the agent's goal):**
1. Confirm the app exists (official site / app store listing)
2. Verified revenue (MRR/ARR) with source URL — founder posts, Indie Hackers, press
3. Target market / customer profile
4. Pricing model
5. Launch year
6. Primary distribution channel (SEO, TikTok, Product Hunt, etc.)
7. 2–3 stated success factors

**Loop guardrails (mandatory):**
- Hard cap: `MAX_RESEARCH_ITERATIONS` tool calls per app. On hitting the cap, save whatever was found with `research_status='partial'` and move on.
- The agent must stop early when the checklist is satisfied — include an explicit "if all checklist items answered, output final JSON now" instruction.
- If after 3 searches nothing confirms the app exists, stop with `research_status='not_found'`. Do not keep reformulating queries.
- Distinguish claimed vs verified revenue. If no independent source is found, record `verified_revenue=null` and note "unverified — claimed $X in video".
- Every factual field must carry a source URL in `sources_json`. No source → leave the field null. Never let the model fill gaps from prior knowledge.
- Rate-limit: process apps sequentially or max 3 concurrent. Add exponential backoff on 429s.

### Stage 4 — Synthesize

- Single call. Input: all research rows as JSON (this corpus fits in context; do not build RAG for this).
- Output two markdown sections:
  - **Trends:** patterns across niche, revenue band, pricing, distribution, founder type, time-to-revenue. Must reference specific apps as evidence for each pattern.
  - **Ideas:** 3–5 new app ideas, each justified by the identified trends, with target market and suggested distribution channel. Must be grounded in the data, not generic.
- Store in `reports` and also write `./output/report-{channel}-{date}.md`.

### Stage 5 — Output

- CLI prints a summary table: apps found, research complete/partial/not_found counts, report path.
- Export `./output/apps-{channel}-{date}.csv` with all app + research fields for manual filtering in Excel.

## CLI Interface (Phase 1)

```
npm run pipeline -- --channel <url>          # full run
npm run pipeline -- --channel <url> --stage ingest|extract|research|synthesize
npm run pipeline -- --status                 # show DB counts per stage
```

Each stage must be independently runnable and resumable (reads DB state, processes only pending rows).

## Cost Controls

- Before the research stage begins, print estimated cost (apps × avg tokens) and require a `--confirm` flag or interactive y/n. Never silently start a run that could exceed ~$20.
- Log token usage per stage to the console at completion.

## Error Handling Rules

- One failing item (video, app) never halts the batch. Log, mark status, continue.
- All external calls (YouTube, Anthropic) wrapped with retry (max 3, exponential backoff) then graceful failure.
- Every run writes a log file to `./logs/run-{timestamp}.log`.

## Scope Boundaries — DO NOT

- Do not build any web UI, Next.js code, or API routes in Phase 1.
- Do not add audio transcription (Whisper) for caption-less videos.
- Do not add embeddings/RAG/vector DB. Context stuffing is sufficient at this scale.
- Do not add LangChain or any agent framework.
- Do not scrape YouTube HTML — use official API + transcript package only.
- Do not research apps beyond those extracted from the videos.
- Do not add authentication, user accounts, or multi-tenancy.

## Definition of Done (Phase 1)

Phase 1 is complete when, given a real channel URL with 20+ videos:

1. `npm run pipeline -- --channel <url>` runs end-to-end without manual intervention.
2. ≥90% of videos with available transcripts produce extraction results.
3. Every researched app has `research_status` set and sources for all non-null fields.
4. The report markdown contains trends citing specific apps and 3–5 grounded ideas.
5. Re-running the same command is idempotent (no duplicate rows, skips completed work).
6. Total run stays within the printed cost estimate ±30%.

## Agent Working Rules (for Claude Code)

- Work stage by stage in pipeline order. Get each stage running against real data before starting the next.
- After completing each stage, stop and report: what was built, what was tested, token/cost observations, and any blockers. Wait for approval before the next stage.
- If stuck on the same error after 3 distinct fix attempts, stop and report the error, what was tried, and 2 proposed alternatives. Do not retry indefinitely.
- If a dependency or API behaves differently than this spec assumes (e.g., transcript package API changed), stop and report rather than improvising a workaround that changes architecture.
- Write minimal tests: one integration test per stage using a fixture transcript / mocked API responses. No exhaustive unit test suites.
- Keep files small and single-purpose: `src/ingest.ts`, `src/extract.ts`, `src/research.ts`, `src/synthesize.ts`, `src/db.ts`, `src/cli.ts`.

## Phase 2 Preview (do not implement yet)

Next.js app: URL input → confirmation modal (video count + cost estimate) → background job (Inngest or Azure Functions + queue) → progress via polling → filterable results table → report view → chat endpoint that stuffs all findings into context and answers questions. This section exists only so Phase 1 decisions (SQLite schema, stage separation, resumability) stay compatible with it.
