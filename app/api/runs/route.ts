import { NextResponse } from 'next/server';
import { inngest } from '@/src/server/inngest';
import { createRun } from '@/src/server/pg';

export const dynamic = 'force-dynamic';

/** Start a pipeline run: create the run row and hand off to Inngest. */
export async function POST(request: Request) {
  try {
    const { channelUrl } = await request.json();
    if (typeof channelUrl !== 'string' || !channelUrl.trim()) {
      return NextResponse.json({ error: 'channelUrl is required' }, { status: 400 });
    }
    const runId = await createRun(channelUrl.trim());
    await inngest.send({
      name: 'appscout/pipeline.requested',
      data: { runId, channelUrl: channelUrl.trim() },
    });
    return NextResponse.json({ runId }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
