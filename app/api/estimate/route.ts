import { NextResponse } from 'next/server';
import { estimateRun } from '@/src/server/stages';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { channelUrl } = await request.json();
    if (typeof channelUrl !== 'string' || !channelUrl.trim()) {
      return NextResponse.json({ error: 'channelUrl is required' }, { status: 400 });
    }
    const estimate = await estimateRun(channelUrl.trim());
    return NextResponse.json(estimate);
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
