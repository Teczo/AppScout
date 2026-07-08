'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface RunStatus {
  id: number;
  channel_url: string;
  channel_id: number | null;
  status: 'queued' | 'running' | 'complete' | 'error';
  stage: string;
  error: string | null;
  progress: {
    videos: number;
    transcripts: Record<string, number>;
    extraction: Record<string, number>;
    appsTotal: number;
    appsUnique: number;
    research: Record<string, number>;
    reports: number;
  } | null;
}

const STAGES = ['ingest', 'extract', 'research', 'synthesize', 'done'];

export default function RunProgress({ runId }: { runId: number }) {
  const [run, setRun] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: RunStatus = await res.json();
        if (!stop) {
          setRun(body);
          setError(null);
          if (body.status === 'complete' || body.status === 'error') return; // stop polling
        }
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : String(err));
      }
      if (!stop) setTimeout(poll, 3000);
    }
    poll();
    return () => {
      stop = true;
    };
  }, [runId]);

  if (!run) return <p className="muted">Loading run #{runId}…{error && ` (${error})`}</p>;

  const p = run.progress;
  const researched =
    (p?.research.complete ?? 0) + (p?.research.partial ?? 0) + (p?.research.not_found ?? 0);

  return (
    <>
      <h1>Run #{run.id}</h1>
      <p className="muted">{run.channel_url}</p>

      <p>
        {STAGES.map((s, i) => (
          <span key={s}>
            {i > 0 && ' → '}
            <span
              style={{
                fontWeight: run.stage === s ? 700 : 400,
                color:
                  STAGES.indexOf(run.stage) > i || run.status === 'complete'
                    ? 'var(--ok)'
                    : run.stage === s
                      ? 'var(--fg)'
                      : 'var(--muted)',
              }}
            >
              {s}
            </span>
          </span>
        ))}
      </p>

      {run.status === 'error' && (
        <div className="card" style={{ borderColor: 'var(--bad)' }}>
          <strong style={{ color: 'var(--bad)' }}>Run failed:</strong> {run.error}
        </div>
      )}

      {p && (
        <div className="progress-grid">
          <div className="stat">
            <div className="n">{p.videos}</div>
            <div className="l">videos ({p.transcripts.ok ?? 0} transcripts ok)</div>
          </div>
          <div className="stat">
            <div className="n">
              {p.extraction.done ?? 0}/{(p.extraction.done ?? 0) + (p.extraction.pending ?? 0) + (p.extraction.failed ?? 0)}
            </div>
            <div className="l">videos extracted</div>
          </div>
          <div className="stat">
            <div className="n">{p.appsUnique}</div>
            <div className="l">unique apps found</div>
          </div>
          <div className="stat">
            <div className="n">
              {researched}/{p.appsUnique}
            </div>
            <div className="l">
              researched ({p.research.complete ?? 0} complete / {p.research.partial ?? 0} partial /{' '}
              {p.research.not_found ?? 0} not found)
            </div>
          </div>
          <div className="stat">
            <div className="n">{p.reports > 0 ? '✓' : '…'}</div>
            <div className="l">report</div>
          </div>
        </div>
      )}

      {run.status === 'complete' && run.channel_id && (
        <p>
          <Link href={`/channels/${run.channel_id}`}>
            <button>View results →</button>
          </Link>
        </p>
      )}
      {run.status !== 'complete' && run.status !== 'error' && (
        <p className="muted">Updates every 3 seconds — safe to leave and come back.</p>
      )}
    </>
  );
}
