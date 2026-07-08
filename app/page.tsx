import Link from 'next/link';
import { listChannels } from '@/src/server/pg';
import StartRun from './components/StartRun';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const channels = await listChannels().catch(() => []);

  return (
    <>
      <h1>Research a channel</h1>
      <p className="muted">
        Paste a YouTube channel URL. AppScout lists its videos, extracts every app discussed,
        verifies each one with web research, and synthesizes trends and new app ideas.
      </p>
      <StartRun />

      <h2>Channels</h2>
      {channels.length === 0 ? (
        <p className="muted">Nothing ingested yet — start a run above.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Videos</th>
              <th>Unique apps</th>
              <th>Report</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/channels/${c.id}`}>{c.channel_name}</Link>
                </td>
                <td>{c.video_count}</td>
                <td>{c.apps_unique}</td>
                <td>{c.has_report ? '✓' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
