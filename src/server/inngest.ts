import { Inngest } from 'inngest';
import { updateRun } from './pg.js';
import {
  extractChunk,
  ingestResolve,
  ingestTranscripts,
  pendingResearchAppIds,
  researchOne,
  synthesize,
} from './stages.js';

export const inngest = new Inngest({ id: 'appscout' });

const INGEST_CHUNK = 10; // transcripts per step
const EXTRACT_CHUNK = 8; // videos per step

/**
 * The full pipeline as one Inngest function. Each step is a separate,
 * retried, memoized invocation, so long channels never hit serverless time
 * limits: ingest and extract run in chunks, research runs one app per step.
 * All state lives in Postgres and every stage is resumable, so retries and
 * re-runs are safe.
 */
export const runPipeline = inngest.createFunction(
  {
    id: 'appscout-pipeline',
    concurrency: { limit: 1 }, // sequential research per spec; one run at a time
    onFailure: async ({ event, error }) => {
      const runId = (event.data.event.data as { runId?: number }).runId;
      if (runId) {
        await updateRun(runId, { status: 'error', error: String(error).slice(0, 1000) });
      }
    },
  },
  { event: 'appscout/pipeline.requested' },
  async ({ event, step }) => {
    const { runId, channelUrl } = event.data as { runId: number; channelUrl: string };

    // Stage 1 — ingest
    await step.run('run-start', () => updateRun(runId, { status: 'running', stage: 'ingest' }));
    const resolved = await step.run('ingest-resolve', () => ingestResolve(channelUrl));
    await step.run('run-channel', () => updateRun(runId, { channel_id: resolved.channelId }));
    for (let i = 0; i < resolved.videos.length; i += INGEST_CHUNK) {
      const chunk = resolved.videos.slice(i, i + INGEST_CHUNK);
      await step.run(`ingest-transcripts-${i}`, () => ingestTranscripts(resolved.channelId, chunk));
    }

    // Stage 2 — extract (loop until no pending videos remain)
    await step.run('stage-extract', () => updateRun(runId, { stage: 'extract' }));
    for (let round = 0; ; round++) {
      const processed = await step.run(`extract-${round}`, () => extractChunk(EXTRACT_CHUNK));
      if (processed === 0) break;
    }

    // Stage 3 — research (one app per step, deduped by normalized name)
    await step.run('stage-research', () => updateRun(runId, { stage: 'research' }));
    const appIds = await step.run('research-plan', () => pendingResearchAppIds(resolved.channelId));
    for (const appId of appIds) {
      await step.run(`research-app-${appId}`, () => researchOne(appId));
    }

    // Stage 4 — synthesize
    await step.run('stage-synthesize', () => updateRun(runId, { stage: 'synthesize' }));
    const reportId = await step.run('synthesize', () => synthesize(resolved.channelId));

    await step.run('run-complete', () => updateRun(runId, { status: 'complete', stage: 'done' }));
    return { channelId: resolved.channelId, apps: appIds.length, reportId };
  },
);
