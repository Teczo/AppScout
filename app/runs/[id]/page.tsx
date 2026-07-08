import RunProgress from '../../components/RunProgress';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunProgress runId={Number(id)} />;
}
