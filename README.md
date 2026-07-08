# AppScout — Progress & Status

AppScout ingests a YouTube channel URL, extracts every app discussed across the channel's videos, researches each app on the web (revenue, market, pricing), synthesizes cross-app trends, and suggests new app ideas. The full product plan, phase gates, and specs live in [CLAUDE.md](./CLAUDE.md).

This README is a **repo audit as of 2026-07-08**: what is built, what is verified, and where the code diverges from the current CLAUDE.md spec.

---

## Status at a glance

| Phase | Deliverable | Spec status | Actual repo state |
|---|---|---|---|
| 1 | CLI pipeline (ingest → extract → research → synthesize) | ← START HERE | **Code complete**, tests pass — but **not yet validated against a real channel** and not user-approved |
| 2 | Local web app (input UI, background jobs, results) | blocked on 1 | **Largely built** (built before the phase gate; predates the current CLAUDE.md) |
| 3 | Chat with findings + report polish | blocked on 2 | **Partially built** (basic non-streaming chat exists) |
| 4 | Production deployment | blocked on 3 | Not started (deployment *guide* written: [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md), plus a Dockerfile) |
| 5 | Multi-user productization | blocked on 4 | Not started |

**Verified in this audit:** `npm run typecheck` passes clean; `npm test` passes — 20 tests across 5 files, one integration test file per pipeline stage (`test/ingest|extract|research|synthesize|output.test.ts`) with fixtures and mocked APIs, matching the testing rule in CLAUDE.md.

**Not verified:** no end-to-end run against a real channel has been recorded, so none of the Phase 1 Definition of Done items (real 20+ video channel, ≥90% extraction rate, idempotent re-run, cost within estimate ±30%) are confirmed yet.

---

## What's built

### Phase 1 — CLI pipeline (`src/`)

All five stages are implemented as library functions plus a thin CLI (`src/cli.ts`):

| Stage | File | Notes |
|---|---|---|
| 1. Ingest | `src/ingest.ts`, `src/youtube.ts` | Resolves `/channel/UC…`, `/@handle`, `/c/name`; YouTube Data API v3 for listing, `youtube-transcript` for captions; marks `unavailable` and continues (no Whisper); idempotent — skips videos already stored with `transcript_status='ok'` |
| 2. Extract | `src/extract.ts` | `claude-haiku-4-5`, one call per transcript, 50k-char truncation, JSON forced via a `record_apps` tool, Zod-validated, one retry with the validation error appended, per-video failure never halts the batch |
| 3. Research | `src/research.ts` | `claude-sonnet-4-6` + web search tool; agent loop capped at `MAX_RESEARCH_ITERATIONS`; early-exit instruction; 3-strikes → `not_found`; claimed vs verified revenue kept separate; per-field source URLs in `sources_json` |
| 4. Synthesize | `src/synthesize.ts` | `claude-sonnet-4-6`, single call over the full research corpus (no RAG), trends + ideas markdown stored in `reports` and written to `./output/report-{channel}-{date}.md` |
| 5. Output | `src/output.ts` | Summary table on the CLI + `./output/apps-{channel}-{date}.csv` export |

Supporting pieces: `src/config.ts` (fail-fast env validation, per-stage key requirements), `src/retry.ts` (exponential backoff), `src/logger.ts` (structured run logs), `src/db.ts` (schema + queries).

CLI matches the spec'd interface:

```
npm run pipeline -- --channel <url>                # full run
npm run pipeline -- --channel <url> --stage <name> # single stage, resumable
npm run pipeline -- --status                       # DB counts per stage
```

Cost gate: the research stage prints an estimated cost and requires `--confirm` or an interactive y/n before proceeding.

### Phase 2 — Web app (`app/`, `src/server/`)

Built **ahead of the phase gate** (it predates the current CLAUDE.md revision):

- **Input + confirm:** `app/page.tsx` + `StartRun.tsx` — paste URL → `/api/estimate` resolves the channel and returns video count + cost estimate → confirm panel → `/api/runs` creates a run and fires an Inngest event.
- **Background execution:** `src/server/inngest.ts` — the whole pipeline as one Inngest function with chunked steps (ingest/extract in chunks, research one app per step) so serverless time limits are never hit; reuses the Phase 1 stage functions via `src/server/stages.ts` (no pipeline logic duplicated — only the DB layer differs, see divergences).
- **Progress UI:** `app/runs/[id]/page.tsx` + `RunProgress.tsx` polls `/api/runs/[id]` (3s) with stage indicator and live counts.
- **Results:** `app/channels/[id]/page.tsx` + `AppsTable.tsx` — apps table with text search and research-status filter, plus the report below it.
- **Postgres layer:** `src/server/pg.ts` — hand-rolled `pg` pool mirroring the SQLite schema, plus a `runs` table.

### Phase 3 — Chat (partial)

- `app/api/channels/[id]/chat/route.ts` + `Chat.tsx` — Q&A over a channel's findings using context stuffing (`chatWithFindings` in `src/server/stages.ts`). Non-streaming, no session persistence.

### Docs & ops

- `docs/DEPLOYMENT.md` — key acquisition (Anthropic, YouTube), local go-live, Azure and Vercel hosting guides.
- `Dockerfile`, `.dockerignore`, `.env.example`.

---

## Divergences from CLAUDE.md (the important part)

The code was written against an earlier plan; the updated CLAUDE.md changes several decisions. Ordered by impact:

1. **Storage: SQLite instead of Postgres + Drizzle.** The CLI uses `better-sqlite3` (`DB_PATH`, default `./data/appscout.db`). The web app has a *separate* hand-rolled Postgres layer (`src/server/pg.ts`, raw SQL, no Drizzle, no migrations). CLAUDE.md specifies Postgres via `drizzle-orm` **from day one** precisely to avoid this dual-schema split — and there is no `docker-compose.yml` for local Postgres. This is the biggest re-alignment item, and it also breaks the Phase 2 DoD item "CLI from Phase 1 still works against the same DB" (they currently use different databases).

2. **Repo layout: flat single package, not pnpm workspaces.** Spec calls for `/packages/pipeline` + `/apps/web` with pnpm; the repo is one npm package with `src/` (pipeline), `src/server/` (web glue), and `app/` (Next.js) side by side. Functionally the pipeline *is* library-shaped (the web app imports the same stage functions), but the workspace structure doesn't match.

3. **Phase gating violated historically.** Phases 2 and part of 3 were built before Phase 1 was validated or approved. Nothing new should be added to `app/` until Phase 1's Definition of Done is demonstrated and approved.

4. **`MAX_RUN_COST_USD` not implemented.** The env var appears nowhere in the code. There's a *pre-run* estimate + confirmation, but no *runtime* accumulated-cost abort. (Full daily caps are Phase 4, but the per-run abort threshold is a cross-phase env var in the spec.)

5. **`runs` status model differs.** Implemented: `queued | running | complete | error`. Spec: `pending_confirm | running | complete | failed | cancelled`. There's no persisted `pending_confirm`/`cancelled` — cancel is client-side only (spec: "Cancelling before confirm leaves no orphaned jobs" needs a DB-visible state).

6. **Web results table is thinner than spec.** Has text search + research-status filter; missing niche multi-select, revenue band and launch-year filters, sortable columns, CSV/MD download buttons, and run history per channel. Report is rendered as raw text, not markdown. No Tailwind (spec: Tailwind; currently plain CSS in `globals.css`).

7. **Chat diverges from Phase 3 spec.** Non-streaming (spec requires streaming), no `chat_sessions`/`chat_messages` persistence, no 50-message cap, and it's scoped per channel rather than per run.

8. **Minor schema drift.** `apps.normalized_name` vs spec `name_normalized`; no `runs.progress_pct`/`cost_usd` columns; `videos.extraction_status` was added (a useful addition, worth back-porting into CLAUDE.md's data model). `.env.example` is missing `MAX_RUN_COST_USD`.

---

## Suggested next steps

1. **Decide the storage migration** — moving both CLI and web to one Postgres schema via Drizzle (per spec) retires `src/db.ts` *and* `src/server/pg.ts`; add `docker-compose.yml` for local dev. This is the prerequisite for everything else.
2. **Run Phase 1 end-to-end against a real channel** (20+ videos) and check off the Phase 1 Definition of Done; record extraction rate, cost vs estimate, and idempotency of a re-run.
3. **Get Phase 1 explicitly approved**, then bring the existing web app up to the Phase 2 spec (runs status model, filters, downloads, markdown report, Tailwind) rather than building more Phase 3 features.
4. **Add the `MAX_RUN_COST_USD` runtime abort** while touching the pipeline.

## Getting started

```bash
npm install
cp .env.example .env      # fill in ANTHROPIC_API_KEY, YOUTUBE_API_KEY
npm run pipeline -- --channel https://www.youtube.com/@somechannel
npm run pipeline -- --status
npm test                  # 20 tests, mocked APIs — no keys needed
npm run dev               # Phase 2 web app (needs DATABASE_URL + Inngest dev server)
```
