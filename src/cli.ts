import { parseArgs } from 'node:util';
import { loadConfig, type RequiredKey } from './config.js';
import { getStatusCounts, openDb } from './db.js';
import { runExtract } from './extract.js';
import { runIngest } from './ingest.js';
import { Logger } from './logger.js';

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
        case 'research':
        case 'synthesize':
          logger.warn(`Stage "${stage}" is not implemented yet (Phase 1 is being built stage by stage).`);
          if (values.stage) process.exitCode = 1;
          return;
      }
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
