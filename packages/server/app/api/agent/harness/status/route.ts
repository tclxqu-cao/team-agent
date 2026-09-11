import { NextResponse } from 'next/server';
import { agentHost } from '../../../agent-host';

export const dynamic = 'force-dynamic';
export async function GET() {
  return NextResponse.json(agentHost.getHarnessStatus(), { headers: { 'cache-control': 'no-store' } });
}
