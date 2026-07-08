'use client';

import { useMemo, useState } from 'react';

export interface AppRow {
  name: string;
  niche: string | null;
  description: string | null;
  founder: string | null;
  videoCount: number;
  claimedRevenue: string | null;
  researchStatus: string | null;
  verifiedRevenue: string | null;
  revenueSourceUrl: string | null;
  targetMarket: string | null;
  pricingModel: string | null;
  launchYear: number | null;
  distributionChannel: string | null;
  successFactors: string[] | null;
  notes: string | null;
}

export default function AppsTable({ rows }: { rows: AppRow[] }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== 'all' && (r.researchStatus ?? 'pending') !== status) return false;
      if (!q) return true;
      return [r.name, r.niche, r.description, r.targetMarket, r.distributionChannel, r.founder]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [rows, search, status]);

  return (
    <>
      <div className="table-controls">
        <input
          type="text"
          placeholder="Filter by name, niche, market…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="complete">complete</option>
          <option value="partial">partial</option>
          <option value="not_found">not_found</option>
          <option value="pending">pending</option>
        </select>
        <span className="muted" style={{ alignSelf: 'center', fontSize: 13 }}>
          {filtered.length} of {rows.length}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="data">
          <thead>
            <tr>
              <th>App</th>
              <th>Niche</th>
              <th>Status</th>
              <th>Revenue (verified)</th>
              <th>Revenue (claimed)</th>
              <th>Market</th>
              <th>Pricing</th>
              <th>Launched</th>
              <th>Distribution</th>
              <th>Success factors</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.name}>
                <td>
                  <strong>{r.name}</strong>
                  {r.videoCount > 1 && <span className="muted"> ×{r.videoCount}</span>}
                  {r.description && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {r.description}
                    </div>
                  )}
                </td>
                <td>{r.niche ?? '—'}</td>
                <td>
                  <span className={`badge ${r.researchStatus ?? 'pending'}`}>
                    {r.researchStatus ?? 'pending'}
                  </span>
                </td>
                <td>
                  {r.verifiedRevenue ? (
                    r.revenueSourceUrl ? (
                      <a href={r.revenueSourceUrl} target="_blank" rel="noreferrer">
                        {r.verifiedRevenue}
                      </a>
                    ) : (
                      r.verifiedRevenue
                    )
                  ) : (
                    <span className="muted">{r.notes?.includes('unverified') ? 'unverified' : '—'}</span>
                  )}
                </td>
                <td>{r.claimedRevenue ?? '—'}</td>
                <td>{r.targetMarket ?? '—'}</td>
                <td>{r.pricingModel ?? '—'}</td>
                <td>{r.launchYear ?? '—'}</td>
                <td>{r.distributionChannel ?? '—'}</td>
                <td>{r.successFactors?.join('; ') ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
