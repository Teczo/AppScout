import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { formatSummary, runOutput } from '../src/output.js';

const CHANNEL_URL = 'https://www.youtube.com/@indieappchannel';

function seed(db: Database.Database): void {
  db.prepare(`INSERT INTO channels (channel_url, channel_name, video_count) VALUES (?, 'Indie App Channel', 2)`).run(CHANNEL_URL);
  const video = db.prepare(
    `INSERT INTO videos (channel_id, video_id, title, published_at, transcript_status, transcript_text, extraction_status)
     VALUES (1, ?, 't', '2026-06-01', 'ok', 'x', 'done')`,
  );
  video.run('vid-1');
  video.run('vid-2');
  const app = db.prepare(
    `INSERT INTO apps (video_id, name, normalized_name, description, niche, claimed_revenue, founder, extraction_confidence)
     VALUES (?, ?, ?, ?, 'productivity', ?, 'Maya Chen', 'high')`,
  );
  // FocusKit appears in both videos (dedup case); description has a comma to exercise CSV quoting
  app.run(1, 'FocusKit', 'focuskit', 'Pomodoro timer, for teams', '$40k MRR');
  app.run(2, 'Focus Kit', 'focuskit', 'dup mention', '$40k MRR');
  app.run(2, 'GhostApp', 'ghostapp', 'mystery tool', null);
  db.prepare(
    `INSERT INTO research (app_id, verified_revenue, revenue_source_url, target_market, pricing_model,
                           launch_year, distribution_channel, success_factors, research_status, sources_json)
     VALUES (1, '$38k MRR', 'https://indiehackers.com/focuskit', 'remote teams', '$12/mo', 2025, 'SEO',
             '["SEO content","TikTok clips"]', 'complete',
             '{"sources":[{"field":"verified_revenue","url":"https://indiehackers.com/focuskit"}],"notes":null}')`,
  ).run();
  db.prepare(
    `INSERT INTO research (app_id, verified_revenue, research_status, sources_json)
     VALUES (3, NULL, 'not_found', '{"sources":[],"notes":"unverified — claimed nothing"}')`,
  ).run();
  db.prepare(`INSERT INTO reports (channel_id, trends_md, ideas_md) VALUES (1, 'trends', 'ideas')`).run();
}

describe('stage 5: output (summary + CSV export)', () => {
  let db: Database.Database;
  let outputDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appscout-out-'));
  });

  it('writes one CSV row per unique app with app + research fields', () => {
    seed(db);
    const summary = runOutput(db, { channelUrl: CHANNEL_URL, outputDir });

    expect(summary.csvPath).toMatch(/apps-indie-app-channel-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = fs.readFileSync(summary.csvPath, 'utf8');
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 unique apps (FocusKit deduped)

    expect(lines[0]).toBe(
      'name,niche,description,founder,extraction_confidence,video_count,claimed_revenue,' +
        'research_status,verified_revenue,revenue_source_url,target_market,pricing_model,' +
        'launch_year,distribution_channel,success_factors,notes,source_urls',
    );
    // Comma in description is quoted; research fields joined; video_count counts both mentions
    expect(lines[1]).toContain('"Pomodoro timer, for teams"');
    expect(lines[1]).toContain('$38k MRR');
    expect(lines[1]).toContain('SEO content; TikTok clips');
    expect(lines[1]).toContain('verified_revenue: https://indiehackers.com/focuskit');
    expect(lines[1]).toContain(',Maya Chen,high,2,$40k MRR,'); // video_count=2 across both mentions
    // not_found app keeps its note, empty verified fields
    expect(lines[2]).toContain('not_found');
    expect(lines[2]).toContain('unverified');
  });

  it('returns the summary counts and report path for the CLI table', () => {
    seed(db);
    const summary = runOutput(db, { channelUrl: CHANNEL_URL, outputDir });

    expect(summary).toMatchObject({
      channelName: 'Indie App Channel',
      videos: 2,
      transcriptsOk: 2,
      appsTotal: 3,
      appsUnique: 2,
      research: { complete: 1, not_found: 1 },
    });
    expect(summary.reportPath).toMatch(/report-indie-app-channel-\d{4}-\d{2}-\d{2}\.md$/);

    const table = formatSummary(summary);
    expect(table).toContain('apps found');
    expect(table).toContain('3 (2 unique)');
    expect(table).toContain('research complete      1');
    expect(table).toContain('research not_found     1');
  });

  it('works before research/synthesis: empty research counts and no report path', () => {
    db.prepare(`INSERT INTO channels (channel_url, channel_name, video_count) VALUES (?, 'Fresh', 0)`).run(CHANNEL_URL);
    const summary = runOutput(db, { channelUrl: CHANNEL_URL, outputDir });

    expect(summary).toMatchObject({ videos: 0, appsTotal: 0, appsUnique: 0, research: {}, reportPath: null });
    const csv = fs.readFileSync(summary.csvPath, 'utf8');
    expect(csv.trim().split('\r\n')).toHaveLength(1); // header only
  });
});
