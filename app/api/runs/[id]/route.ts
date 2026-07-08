import { NextResponse } from 'next/server';
import { getChannelProgress, getRun } from '@/src/server/pg';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const run = await getRun(Number(id));
    if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
    const progress = run.channel_id ? await getChannelProgress(run.channel_id) : null;
    return NextResponse.json({ ...run, progress });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
