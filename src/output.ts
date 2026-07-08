import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface OutputSummary {
  channelName: string;
  videos: number;
  transcriptsOk: number;
  appsTotal: number;
  appsUnique: number;
  research: Record<string, number>;
  reportPath: string | null;
  csvPath: string;
}

const CSV_COLUMNS = [
  'name',
  'niche',
  'description',
  'founder',
  'extraction_confidence',
  'video_count',
  'claimed_revenue',
  'research_status',
  'verified_revenue',
  'revenue_source_url',
  'target_market',
  'pricing_model',
  'launch_year',
  'distribution_channel',
  'success_factors',
  'notes',
  'source_urls',
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'channel';
}

/**
 * Stage 5: export apps-{channel}-{date}.csv (one row per unique app, all
 * app + research fields) and return the run summary for the CLI table.
 */
export function runOutput(
  db: Database.Database,
  opts: { channelUrl: string; outputDir?: string },
): OutputSummary {
  const outputDir = opts.outputDir ?? './output';
  const channel = db
    .prepare('SELECT id, channel_name FROM channels WHERE channel_url = ?')
    .get(opts.channelUrl) as { id: number; channel_name: string } | undefined;
  if (!channel) {
    throw new Error(`Channel not found in DB for URL ${opts.channelUrl} — run the ingest stage first.`);
  }

  // One row per unique app (canonical = lowest id per normalized_name),
  // left-joined with its research findings.
  const rows = db
    .prepare(
      `SELECT a.name, a.niche, a.description, a.founder, a.extraction_confidence,
              a.claimed_revenue,
              (SELECT COUNT(*) FROM apps d JOIN videos dv ON dv.id = d.video_id
               WHERE d.normalized_name = a.normalized_name AND dv.channel_id = ?) AS video_count,
              r.research_status, r.verified_revenue, r.revenue_source_url, r.target_market,
              r.pricing_model, r.launch_year, r.distribution_channel, r.success_factors, r.sources_json
       FROM apps a
       JOIN videos v ON v.id = a.video_id
       LEFT JOIN research r ON r.app_id = a.id
       WHERE v.channel_id = ?
         AND a.id = (SELECT MIN(a2.id) FROM apps a2 WHERE a2.normalized_name = a.normalized_name)
       ORDER BY a.name COLLATE NOCASE`,
    )
    .all(channel.id, channel.id) as Record<string, unknown>[];

  const csvLines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    const sourcesJson = row.sources_json ? JSON.parse(row.sources_json as string) : null;
    const record: Record<string, unknown> = {
      ...row,
      success_factors: row.success_factors
        ? (JSON.parse(row.success_factors as string) as string[]).join('; ')
        : null,
      notes: sourcesJson?.notes ?? null,
      source_urls: sourcesJson?.sources
        ? (sourcesJson.sources as { field: string; url: string }[])
            .map((s) => `${s.field}: ${s.url}`)
            .join('; ')
        : null,
    };
    csvLines.push(CSV_COLUMNS.map((col) => csvEscape(record[col])).join(','));
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const csvPath = path.join(outputDir, `apps-${slugify(channel.channel_name)}-${date}.csv`);
  fs.writeFileSync(csvPath, csvLines.join('\r\n') + '\r\n');

  const count = (sql: string): number => (db.prepare(sql).get(channel.id) as { n: number }).n;
  const researchCounts = Object.fromEntries(
    (
      db
        .prepare(
          `SELECT r.research_status AS key, COUNT(*) AS n FROM research r
           JOIN apps a ON a.id = r.app_id JOIN videos v ON v.id = a.video_id
           WHERE v.channel_id = ? GROUP BY r.research_status`,
        )
        .all(channel.id) as { key: string; n: number }[]
    ).map((r) => [r.key, r.n]),
  );

  const latestReport = db
    .prepare('SELECT created_at FROM reports WHERE channel_id = ? ORDER BY id DESC LIMIT 1')
    .get(channel.id) as { created_at: string } | undefined;
  const reportPath = latestReport
    ? path.join(outputDir, `report-${slugify(channel.channel_name)}-${latestReport.created_at.slice(0, 10)}.md`)
    : null;

  return {
    channelName: channel.channel_name,
    videos: count('SELECT COUNT(*) AS n FROM videos WHERE channel_id = ?'),
    transcriptsOk: count(`SELECT COUNT(*) AS n FROM videos WHERE channel_id = ? AND transcript_status = 'ok'`),
    appsTotal: count(
      'SELECT COUNT(*) AS n FROM apps a JOIN videos v ON v.id = a.video_id WHERE v.channel_id = ?',
    ),
    appsUnique: rows.length,
    research: researchCounts,
    reportPath,
    csvPath,
  };
}

export function formatSummary(s: OutputSummary): string {
  const line = (label: string, value: string | number) => `  ${label.padEnd(22)} ${value}`;
  return [
    `\nAppScout run summary — ${s.channelName}`,
    line('videos ingested', s.videos),
    line('transcripts ok', s.transcriptsOk),
    line('apps found', `${s.appsTotal} (${s.appsUnique} unique)`),
    line('research complete', s.research.complete ?? 0),
    line('research partial', s.research.partial ?? 0),
    line('research not_found', s.research.not_found ?? 0),
    line('report', s.reportPath ?? '(none yet)'),
    line('csv export', s.csvPath),
  ].join('\n');
}
