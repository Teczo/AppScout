# CLAUDE.md — App Trend Research Pipeline ("AppScout")

## Project Overview

AppScout ingests a YouTube channel URL, extracts every app discussed across the channel's videos, runs web research on each app (revenue, target market, success factors), synthesizes cross-app trends, and suggests new app ideas.

The project is built in five phases. **Each phase has a Definition of Done and a hard gate: do not begin the next phase until the current one is complete and explicitly approved by the user.**

| Phase | Deliverable | Status |
|---|---|---|
| 1 | CLI pipeline (ingest → extract → research → synthesize) | ← START HERE |
| 2 | Local web app: input UI, background jobs, filterable results | blocked on 1 |
| 3 | Chat with findings + report polish | blocked on 2 |
| 4 | Production deployment: auth, hosting, cost controls, monitoring | blocked on 3 |
| 5 | (Optional) Multi-user productization: billing, quotas | blocked on 4 |

**Current phase: Phase 1. Do NOT build any web UI, API routes, or frontend code until Phase 1 is approved.**

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
[5. OUTPUT]      Postgres DB + markdown report  →  (Phase 2+) web UI, chat
```

Steps 1, 2, 4, 5 are deterministic pipelines. Only step 3 is agentic. Keep it that way — do not add agent loops where a single structured call suffices.

## Tech Stack

- **Runtime:** Node.js 20+, TypeScript, ESM modules
- **LLM:** Anthropic Messages API
  - Extraction: `claude-haiku-4-5` (cheap, high volume)
  - Research: `claude-sonnet-4-6` with web search tool
  - Synthesis & chat: `claude-sonnet-4-6`
- **YouTube:** YouTube Data API v3 (video listing), `youtube-transcript` npm package (transcripts)
- **Storage:** Postgres from day one (Docker locally: `docker compose up db`). Avoids a SQLite→Postgres migration at Phase 2. Use `drizzle-orm` for schema + queries.
- **Validation:** Zod schemas for every LLM output. Reject and retry (max 2 retries) on schema failure.
- **Web (Phase 2+):** Next.js 14+ App Router, Tailwind, deployed to Vercel (Phase 4). Background jobs via Inngest.
- **No agent frameworks.** No LangChain, no LlamaIndex. Plain API calls in a loop. These add abstraction without value at this scale.

## Repository Layout

Structure the repo for the end state from the beginning so pipeline code is reusable by the web app:

```
/packages/pipeline/     # Phase 1 — all pipeline logic as a library + thin CLI
  src/ingest.ts
  src/extract.ts
  src/research.ts
  src/synthesize.ts
  src/db/ (schema, queries)
  src/cli.ts
/apps/web/              # Phase 2+ — Next.js app importing @appscout/pipeline
/docker-compose.yml     # Postgres for local dev
```

Use pnpm workspaces. Pipeline functions must be pure library functions (take config, return results) so both the CLI and Inngest jobs can call them.

## Environment Variables

```
ANTHROPIC_API_KEY=          # required
YOUTUBE_API_KEY=            # required, Data API v3
DATABASE_URL=               # required, Postgres connection string
MAX_VIDEOS=100              # hard cap per run
MAX_RESEARCH_ITERATIONS=8   # per app, hard cap on agent loop
MAX_RUN_COST_USD=20         # abort threshold, see Cost Controls
# Phase 4 additions:
NEXTAUTH_SECRET=
NEXTAUTH_URL=
SENTRY_DSN=
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
```

Fail fast with a clear error if a required var is missing. Never hardcode keys. `.env.example` must stay in sync.

## Data Models (Postgres via Drizzle)

```
channels(id, channel_url, channel_name, video_count, ingested_at)

videos(id, channel_id, video_id, title, published_at, transcript_status, transcript_text)
  -- transcript_status: 'ok' | 'unavailable' | 'error'

apps(id, video_id, name, name_normalized, description, niche,
     claimed_revenue, founder, extraction_confidence)
  -- extraction_confidence: 'high' | 'medium' | 'low'
  -- dedupe on name_normalized (lowercase, trimmed) before research

research(id, app_id, verified_revenue, revenue_source_url, target_market,
         pricing_model, launch_year, distribution_channel, success_factors,
         research_status, sources_json, researched_at)
  -- research_status: 'complete' | 'partial' | 'not_found'

reports(id, channel_id, trends_md, ideas_md, created_at)

-- Phase 2 additions:
runs(id, channel_id, status, stage, progress_pct, cost_usd, error, created_at, finished_at)
  -- status: 'pending_confirm' | 'running' | 'complete' | 'failed' | 'cancelled'

-- Phase 3 additions:
chat_sessions(id, report_id, created_at)
chat_messages(id, session_id, role, content, created_at)

-- Phase 4 additions:
users(id, email, created_at)          -- add user_id FK to channels/runs
```

---

# PHASE 1 — CLI Pipeline

## Stage Specs

### Stage 1 — Ingest
- Input: channel URL (handle formats: `/channel/UC...`, `/@handle`, `/c/name`).
- Resolve to channel ID, fetch uploads playlist, list videos (respect `MAX_VIDEOS`, newest first).
- Fetch transcript per video. If unavailable, mark `transcript_status='unavailable'` and continue — do NOT attempt audio download or Whisper transcription. Out of scope.
- Idempotent: re-running skips videos already stored with `transcript_status='ok'`.

### Stage 2 — Extract
- One API call per transcript. Truncate transcripts over 50k characters (keep first 50k).
- System prompt: extract every distinct app/product discussed; return JSON matching the Zod schema; empty array if no specific app. Record revenue figures *as claimed in the video* verbatim in `claimed_revenue`.
- Force JSON via tool-use (a `record_apps` tool with the schema). Never parse freeform text.
- On schema failure: retry once with the validation error appended. Second failure: log, mark video extraction-failed, continue. Never halt the batch for one bad video.

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
- Hard cap: `MAX_RESEARCH_ITERATIONS` tool calls per app. On hitting the cap, save findings with `research_status='partial'` and move on.
- Explicit early-exit instruction: "if all checklist items are answered, output final JSON now."
- If 3 searches fail to confirm the app exists → stop, `research_status='not_found'`. No endless query reformulation.
- Claimed vs verified revenue are separate. No independent source → `verified_revenue=null`, note "unverified — claimed $X in video".
- Every factual field carries a source URL in `sources_json`. No source → null. Never fill gaps from model prior knowledge.
- Max 3 concurrent apps. Exponential backoff on 429s.

### Stage 4 — Synthesize
- Single call. Input: all research rows as JSON (fits in context; do NOT build RAG).
- Output two markdown sections:
  - **Trends:** patterns across niche, revenue band, pricing, distribution, founder type, time-to-revenue — each pattern citing specific apps as evidence.
  - **Ideas:** 3–5 new app ideas, each justified by identified trends, with target market and suggested distribution channel. Grounded in the data, not generic.
- Store in `reports`, also write `./output/report-{channel}-{date}.md`.

### Stage 5 — Output
- CLI prints summary table: apps found, research complete/partial/not_found counts, report path.
- Export `./output/apps-{channel}-{date}.csv` with all app + research fields.

## CLI Interface

```
pnpm pipeline -- --channel <url>            # full run
pnpm pipeline -- --channel <url> --stage ingest|extract|research|synthesize
pnpm pipeline -- --status                   # DB counts per stage
```

Each stage independently runnable and resumable (reads DB state, processes only pending rows).

## Phase 1 Scope Boundaries — DO NOT
- No web UI, Next.js code, or API routes.
- No audio transcription (Whisper) for caption-less videos.
- No embeddings/RAG/vector DB.
- No agent frameworks.
- No YouTube HTML scraping — official API + transcript package only.
- No research beyond apps extracted from videos.
- No auth, users, or multi-tenancy.

## Phase 1 Definition of Done
Given a real channel URL with 20+ videos:
1. `pnpm pipeline -- --channel <url>` runs end-to-end without manual intervention.
2. ≥90% of videos with available transcripts produce extraction results.
3. Every researched app has `research_status` set and sources for all non-null fields.
4. Report markdown contains trends citing specific apps and 3–5 grounded ideas.
5. Re-running is idempotent (no duplicates, skips completed work).
6. Total run stays within printed cost estimate ±30%.

---

# PHASE 2 — Local Web App

Goal: everything Phase 1 does, driven from a browser, running locally (`pnpm dev`). No deployment, no auth yet.

## Features & Flow

1. **Input screen:** paste channel URL → server resolves channel, counts videos, estimates cost → creates a `runs` row with `status='pending_confirm'`.
2. **Confirmation modal:** shows channel name, video count, estimated cost (USD), estimated duration. Buttons: Confirm / Cancel. Confirm fires an Inngest event; Cancel sets `status='cancelled'`.
3. **Background execution:** Inngest functions call the pipeline library stage by stage. Each stage updates `runs.stage` and `runs.progress_pct` (e.g., videos processed / total). Inngest handles retries per its defaults — do not add a second retry layer on top of the pipeline's internal retries.
4. **Progress UI:** run page polls `/api/runs/[id]` every 3s. Shows stage, progress bar, live counts (videos ingested, apps found, apps researched). On failure: show `runs.error` and a Retry button that resumes from the failed stage (resumability from Phase 1 makes this free).
5. **Results table:** all apps for the run, columns: name, niche, claimed vs verified revenue, target market, pricing model, launch year, distribution channel, research status. Filters: niche (multi-select), research status, revenue band, launch year range. Text search on name. Sortable columns. Client-side filtering is fine (dataset is small) — no server pagination needed.
6. **Report view:** rendered markdown of trends + ideas, with a download button (.md) and CSV export of the table respecting active filters.
7. **Run history:** list past runs per channel, link to their results/report.

## Phase 2 Technical Rules
- Web app imports `@appscout/pipeline` — zero pipeline logic duplicated in the web app.
- API routes are thin: validate input (Zod), touch DB, emit Inngest events. No business logic in routes.
- Use React Server Components for read views; client components only where interactivity requires (filters, polling, modal).
- Keep UI clean and minimal — a data tool, not a marketing site. No component library beyond Tailwind + a headless primitive (e.g., Radix) if needed for the modal/select.
- Concurrent runs: allow max 1 active run at a time in Phase 2. Reject new confirms while one is running (clear message). Multi-run concurrency is Phase 5 territory.

## Phase 2 Scope Boundaries — DO NOT
- No deployment, no auth, no user accounts.
- No chat feature yet.
- No WebSockets/SSE — polling is sufficient.
- No design system beyond Tailwind defaults + one accent color.

## Phase 2 Definition of Done
1. Full flow works locally: URL → confirm modal with real cost estimate → background run → live progress → filterable results → report view → CSV/MD download.
2. Killing and restarting the dev server mid-run: Retry resumes the run from the failed/incomplete stage without duplicating work.
3. Cancelling before confirm leaves no orphaned jobs.
4. CLI from Phase 1 still works against the same DB.

---

# PHASE 3 — Chat with Findings + Polish

Goal: conversational Q&A over a run's findings, plus report quality improvements.

## Chat Feature

- Entry point: "Chat" tab on a completed run's page.
- **Context strategy: context stuffing, not RAG.** On each chat request, load the run's full research JSON + report markdown into the system prompt. A 100-app corpus is well within context limits. Do not add embeddings or a vector DB. If the corpus ever exceeds ~150k tokens, stop and report rather than silently truncating.
- System prompt rules for the chat model:
  - Answer only from the provided findings; say "not in the research data" when it isn't.
  - Cite app names and source URLs from `sources_json` when making factual claims.
  - May reason/speculate about ideas and trends but must label speculation as such.
- Streaming responses (Anthropic streaming API → route handler → client). This is the one place streaming is worth it.
- Persist history in `chat_sessions`/`chat_messages`; send full session history on each turn (sessions are short; no summarization machinery).
- Cap: 50 messages per session, then prompt user to start a new session. Prevents unbounded context growth.

## Polish Items
- Report view: table of contents, per-app expandable detail cards linking back to source videos (YouTube deep links with timestamp if available from transcript segments — if timestamps aren't readily available from the transcript package, skip this; do not build timestamp inference).
- Empty/error states for every view.
- Loading skeletons on the results table.
- A "re-run research" button per app (single-app research refresh) for apps with `partial`/`not_found` status.

## Phase 3 Scope Boundaries — DO NOT
- No RAG/embeddings.
- No chat across multiple runs/channels (single-run scope only).
- No voice, no file uploads into chat.

## Phase 3 Definition of Done
1. Chat answers questions about specific apps with correct figures and cites sources.
2. Chat correctly says "not in the research data" for out-of-scope questions.
3. Responses stream token-by-token.
4. Sessions persist across page reloads.
5. Single-app re-research updates the table without a full pipeline run.

---

# PHASE 4 — Production Deployment

Goal: the app is live on the internet, secured, monitored, and cannot run away on cost. Single-user (owner) or small allowlist.

## Hosting & Infra
- **Web app:** Vercel (Next.js native). Alternative if required later: Azure App Service — but default to Vercel for Phase 4.
- **Database:** managed Postgres (Neon or Vercel Postgres). Migrate schema via Drizzle migrations — migrations must be committed and reproducible, no manual SQL in production.
- **Background jobs:** Inngest Cloud (free tier is sufficient). Verify job max-duration limits fit the research stage; if a full research batch exceeds limits, split into per-app job steps (Inngest steps are the natural fit).
- **Secrets:** Vercel env vars + Inngest dashboard. Never in the repo.

## Auth
- NextAuth (Auth.js) with email magic-link or Google provider — whichever is faster to set up.
- **Allowlist:** only emails in an `ALLOWED_EMAILS` env var may sign in. Everyone else gets a "request access" message. This is a personal tool, not a public signup product (that's Phase 5).
- All API routes and Inngest event triggers require an authenticated session. Inngest webhook endpoints secured with signing keys.

## Cost & Abuse Controls (mandatory before go-live)
- Per-run cost estimate enforced: if actual accumulated cost exceeds estimate × 2 or `MAX_RUN_COST_USD`, abort the run, mark `failed` with reason `cost_cap`, notify.
- Daily global cost cap across all runs (env var, default $30/day). Exceeded → new runs blocked until next day.
- Anthropic API: set a workspace spend limit in the Anthropic console as the backstop.
- YouTube API: monitor quota (10k units/day default); ingest stage must fail gracefully with a clear "quota exceeded, retry after midnight PT" error.
- Rate limit run creation: max 5 runs/day per user.

## Monitoring & Ops
- **Sentry** on web app + pipeline package (errors, plus a breadcrumb per pipeline stage).
- Structured logs (JSON) from pipeline stages; Inngest dashboard covers job-level visibility.
- Health check route `/api/health` (DB connectivity check).
- Simple notification on run completion/failure: email via Resend (or skip email and rely on the UI + Sentry alerts if faster — acceptable).
- DB backups: rely on managed Postgres provider's PITR/backups; verify it's enabled.

## Security Checklist
- All inputs validated with Zod at the API boundary.
- Channel URL input sanitized; only youtube.com/youtu.be hosts accepted.
- No API keys ever reach the client bundle (`NEXT_PUBLIC_` audit).
- Dependencies: `pnpm audit` clean of criticals before deploy.
- HTTPS only, secure cookies, CSRF handled by Auth.js defaults.

## Phase 4 Scope Boundaries — DO NOT
- No billing/payments.
- No public signup.
- No custom Kubernetes/VMs/self-hosted infra — managed services only.
- No multi-region, no CDN tuning, no premature scaling work.

## Phase 4 Definition of Done
1. Live at a real domain, sign-in restricted to allowlisted emails.
2. A full run completes end-to-end in production within cost caps.
3. A forced failure (kill a job mid-run) appears in Sentry and is retryable from the UI.
4. Cost caps demonstrably abort an over-budget run (test with a low cap).
5. Secrets audit passes: no keys in repo or client bundle.
6. README documents: deploy steps, env vars, backup/restore, how to rotate keys.

---

# PHASE 5 (OPTIONAL) — Multi-User Productization

Only start this if the user explicitly decides to open the tool to others. Get explicit confirmation of the business model before writing any code.

## Scope
- Public signup (remove allowlist), per-user data isolation (`user_id` on channels/runs/reports/chats; every query scoped by user — add an integration test proving user A cannot read user B's runs).
- **Billing:** Stripe subscriptions (e.g., N runs/month per tier) or pay-per-run credits. Webhook-driven entitlement in DB; never trust client-side plan state.
- **Quotas:** per-plan run limits, video caps per run, chat message caps — all enforced server-side.
- Concurrent runs: queue per user, global concurrency cap to protect API spend.
- Legal pages: privacy policy, terms (note: YouTube API Terms of Service compliance — review data caching/retention rules for stored transcripts before launch).
- Landing page with demo report.

## Phase 5 Definition of Done
1. Stranger can sign up, pay, run a channel, and only ever see their own data.
2. Quota exhaustion produces a clear upgrade prompt, not an error.
3. Stripe webhook failure doesn't grant or revoke access incorrectly (idempotent handlers).
4. Load test: 5 concurrent users' runs queue correctly without exceeding global cost caps.

---

# Cross-Phase Rules

## Cost Controls
- Before any research stage begins (CLI or web), compute and surface an estimated cost. CLI requires `--confirm` flag or interactive y/n; web requires the confirmation modal. Never silently start a run.
- Log token usage per stage.

## Error Handling
- One failing item (video, app) never halts a batch. Log, mark status, continue.
- All external calls wrapped with retry (max 3, exponential backoff) then graceful failure.
- Every run writes structured logs.

## Agent Working Rules (for Claude Code)
- Work phase by phase, and within Phase 1, stage by stage. Get each unit running against real data before the next.
- **After completing each stage/phase, STOP and report:** what was built, what was tested, cost/token observations, blockers. Wait for approval before continuing.
- If stuck on the same error after 3 distinct fix attempts: stop and report the error, what was tried, and 2 proposed alternatives. Do not retry indefinitely.
- If a dependency or API behaves differently than this spec assumes: stop and report rather than improvising a workaround that changes architecture.
- If a task appears to require breaking a scope boundary ("DO NOT" item), stop and ask — never break the boundary silently.
- Tests: one integration test per pipeline stage (fixture transcript / mocked APIs); Phase 2+ add one E2E happy-path test (Playwright) covering URL → confirm → results. No exhaustive unit suites.
- Keep files small and single-purpose. Prefer boring, readable code over clever abstractions.
- Update this file's phase status table as phases complete.
