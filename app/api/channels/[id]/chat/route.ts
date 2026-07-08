import { NextResponse } from 'next/server';
import { chatWithFindings } from '@/src/server/stages';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { question } = await request.json();
    if (typeof question !== 'string' || !question.trim()) {
      return NextResponse.json({ error: 'question is required' }, { status: 400 });
    }
    const answer = await chatWithFindings(Number(id), question.trim());
    return NextResponse.json({ answer });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
