'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Estimate {
  channelName: string;
  videoCount: number;
  estimatedCostUsd: number;
}

export default function StartRun() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchEstimate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/estimate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelUrl: url.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setEstimate(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRun() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelUrl: url.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      router.push(`/runs/${body.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ margin: '16px 0 8px' }}>
      <div className="row">
        <input
          type="url"
          placeholder="https://www.youtube.com/@channel"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && url && !busy && fetchEstimate()}
        />
        <button onClick={fetchEstimate} disabled={!url.trim() || busy}>
          {busy && !estimate ? 'Checking…' : 'Analyze'}
        </button>
      </div>
      {error && <p style={{ color: 'var(--bad)', marginBottom: 0 }}>{error}</p>}

      {estimate && (
        <div className="modal-backdrop" onClick={() => !busy && setEstimate(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Confirm run</h2>
            <p>
              <strong>{estimate.channelName}</strong> — {estimate.videoCount} videos will be
              ingested.
            </p>
            <p>
              Estimated cost: <strong>~${estimate.estimatedCostUsd.toFixed(2)}</strong>
              <br />
              <span className="muted" style={{ fontSize: 13 }}>
                Upper bound — assumes every video yields a researchable app. Actual spend is
                usually lower and is logged per stage.
              </span>
            </p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setEstimate(null)} disabled={busy}>
                Cancel
              </button>
              <button onClick={confirmRun} disabled={busy}>
                {busy ? 'Starting…' : 'Start run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
