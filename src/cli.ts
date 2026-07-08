import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig, type RequiredKey } from './config.js';
import { getStatusCounts, openDb } from './db.js';
import { runExtract } from './extract.js';
import { runIngest } from './ingest.js';
import { Logger } from './logger.js';
import { estimateResearchCostUsd, getPendingApps, runResearch } from './research.js';
import { formatSummary, runOutput } from './output.js';
import { runSynthesize } from './synthesize.js';

const STAGES = ['ingest', 'extract', 'research', 'synthesize'] as const;
type Stage = (typeof STAGES)[number];

const USAGE = `AppScout — app trend research pipeline

Usage:
  npm run pipeline -- --channel <url>                 Full run (all stages)
  npm run pipeline -- --channel <url> --stage <name>  Run one stage (${STAGES.join('|')})
  npm run pipeline -- --status                        Show DB counts per stage

Flags:
  --confirm   Skip the interactive cost confirmation before the research stage
`;

function keysForStages(stages: Stage[]): RequiredKey[] {
  const keys = new Set<RequiredKey>();
  if (stages.includes('ingest')) keys.add('youtube');
  if (stages.some((s) => s === 'extract' || s === 'research' || s === 'synthesize')) keys.add('anthropic');
  return [...keys];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      channel: { type: 'string' },
      stage: { type: 'string' },
      status: { type: 'boolean', default: false },
      confirm: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (values.status) {
    const config = loadConfig([]);
    const db = openDb(config.dbPath);
    const counts = getStatusCounts(db);
    console.log('AppScout status');
    console.log(`  channels: ${counts.channels}`);
    console.log(`  videos:   ${counts.videos}  (transcripts: ${JSON.stringify(counts.transcripts)})`);
    console.log(`  extract:  ${JSON.stringify(counts.extraction)}`);
    console.log(`  apps:     ${counts.apps}`);
    console.log(`  research: ${JSON.stringify(counts.research)}`);
    console.log(`  reports:  ${counts.reports}`);
    db.close();
    return;
  }

  if (!values.channel) {
    console.error('Error: --channel <url> is required (or use --status).\n');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  let stages: Stage[];
  if (values.stage) {
    if (!STAGES.includes(values.stage as Stage)) {
      console.error(`Error: unknown stage "${values.stage}". Valid stages: ${STAGES.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    stages = [values.stage as Stage];
  } else {
    stages = [...STAGES];
  }

  const config = loadConfig(keysForStages(stages));
  const logger = new Logger();
  logger.info(`Run started. Stages: ${stages.join(', ')}. Log: ${logger.logFilePath}`);
  const db = openDb(config.dbPath);

  try {
    for (const stage of stages) {
      switch (stage) {
        case 'ingest': {
          const result = await runIngest(db, logger, {
            channelUrl: values.channel,
            youtubeApiKey: config.youtubeApiKey,
            maxVideos: config.maxVideos,
          });
          console.log(
            `\nIngest summary: channel "${result.channelName}", ${result.videosListed} videos listed, ` +
              `${result.transcripts.ok} transcripts ok, ${result.transcripts.unavailable} unavailable, ` +
              `${result.transcripts.error} errors, ${result.videosSkipped} skipped (already ingested).`,
          );
          break;
        }
        case 'extract': {
          const result = await runExtract(db, logger, { anthropicApiKey: config.anthropicApiKey });
          console.log(
            `\nExtract summary: ${result.videosProcessed} videos processed, ${result.videosFailed} failed, ` +
              `${result.appsExtracted} apps extracted. Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out.`,
          );
          break;
        }
        case 'research': {
          const pendingApps = getPendingApps(db);
          if (pendingApps.length === 0) {
            console.log('\nResearch: no pending apps.');
            break;
          }
          const estimate = estimateResearchCostUsd(pendingApps.length, config.maxResearchIterations);
          console.log(
            `\nResearch will cover ${pendingApps.length} unique app(s) at up to ` +
              `${config.maxResearchIterations} searches each.\nEstimated cost: ~$${estimate.toFixed(2)}`,
          );
          if (!(await confirmRun(values.confirm))) {
            console.log('Research aborted. Re-run with --confirm (or answer y) to proceed.');
            return;
          }
          const result = await runResearch(db, logger, {
            anthropicApiKey: config.anthropicApiKey,
            maxIterations: config.maxResearchIterations,
          });
          console.log(
            `\nResearch summary: ${result.appsResearched} apps researched (${JSON.stringify(result.statusCounts)}), ` +
              `${result.appsFailed} failed (left pending), ${result.searchesUsed} searches. ` +
              `Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out.`,
          );
          break;
        }
        case 'synthesize': {
          const result = await runSynthesize(db, logger, {
            anthropicApiKey: config.anthropicApiKey,
            channelUrl: values.channel,
          });
          if (result.skipped) {
            console.log('\nSynthesize: report already up to date; skipped.');
          } else {
            console.log(
              `\nSynthesize summary: report over ${result.appsInCorpus} apps written to ${result.reportPath}. ` +
                `Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out.`,
            );
          }
          break;
        }
      }
    }

    // Stage 5: summary table + CSV export, after a full run or synthesize.
    if (stages.includes('synthesize')) {
      const summary = runOutput(db, { channelUrl: values.channel });
      logger.info(`Output: CSV written to ${summary.csvPath}`);
      console.log(formatSummary(summary));
    }
  } finally {
    db.close();
  }
}

/** Cost gate: --confirm skips the prompt; otherwise interactive y/n (abort when not a TTY). */
async function confirmRun(confirmFlag: boolean): Promise<boolean> {
  if (confirmFlag) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Proceed? [y/N] ');
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
