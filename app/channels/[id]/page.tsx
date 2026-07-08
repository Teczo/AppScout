import { notFound } from 'next/navigation';
import { getAppResults, getChannel, getLatestReport } from '@/src/server/pg';
import AppsTable, { type AppRow } from '../../components/AppsTable';
import Chat from '../../components/Chat';

export const dynamic = 'force-dynamic';

export default async function ChannelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const channelId = Number(id);
  const channel = await getChannel(channelId);
  if (!channel) notFound();

  const [apps, report] = await Promise.all([getAppResults(channelId), getLatestReport(channelId)]);

  const rows: AppRow[] = apps.map((a) => {
    const sources = a.sources_json ? JSON.parse(a.sources_json) : null;
    return {
      name: a.name,
      niche: a.niche,
      description: a.description,
      founder: a.founder,
      videoCount: a.video_count,
      claimedRevenue: a.claimed_revenue,
      researchStatus: a.research_status,
      verifiedRevenue: a.verified_revenue,
      revenueSourceUrl: a.revenue_source_url,
      targetMarket: a.target_market,
      pricingModel: a.pricing_model,
      launchYear: a.launch_year,
      distributionChannel: a.distribution_channel,
      successFactors: a.success_factors ? JSON.parse(a.success_factors) : null,
      notes: sources?.notes ?? null,
    };
  });

  return (
    <>
      <h1>{channel.channel_name}</h1>
      <p className="muted">{channel.channel_url}</p>

      <h2>Apps ({rows.length} unique)</h2>
      <AppsTable rows={rows} />

      <h2>Report</h2>
      {report ? (
        <div className="report">
          {`## Trends\n\n${report.trends_md}\n\n## Ideas\n\n${report.ideas_md}`}
        </div>
      ) : (
        <p className="muted">No report yet — it appears when the synthesize stage finishes.</p>
      )}

      <h2>Chat with the findings</h2>
      <Chat channelId={channelId} />
    </>
  );
}
