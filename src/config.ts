import 'dotenv/config';

export interface Config {
  anthropicApiKey: string;
  youtubeApiKey: string;
  maxVideos: number;
  maxResearchIterations: number;
  dbPath: string;
}

/**
 * Env vars are validated per-stage: YOUTUBE_API_KEY is only required for
 * ingest, ANTHROPIC_API_KEY only for extract/research/synthesize. `--status`
 * requires neither.
 */
export type RequiredKey = 'anthropic' | 'youtube';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it in your shell or in a .env file (see .env.example).`,
    );
  }
  return value.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}".`);
  }
  return n;
}

export function loadConfig(required: RequiredKey[]): Config {
  return {
    anthropicApiKey: required.includes('anthropic') ? requireEnv('ANTHROPIC_API_KEY') : (process.env.ANTHROPIC_API_KEY ?? ''),
    youtubeApiKey: required.includes('youtube') ? requireEnv('YOUTUBE_API_KEY') : (process.env.YOUTUBE_API_KEY ?? ''),
    maxVideos: intEnv('MAX_VIDEOS', 100),
    maxResearchIterations: intEnv('MAX_RESEARCH_ITERATIONS', 8),
    dbPath: process.env.DB_PATH ?? './data/appscout.db',
  };
}
