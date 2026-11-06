import { NextResponse } from 'next/server';
import { buildState } from '@/lib/state';

export const dynamic = 'force-dynamic';

/** Состояние дашборда: текущие показания + история за 24 ч (только из локальной базы) */
export async function GET() {
  try {
    const state = await buildState();
    return NextResponse.json(state);
  } catch (error) {
    console.error('[api/tuya/state]', error);
    return NextResponse.json({ error: 'Не удалось прочитать локальные данные' }, { status: 500 });
  }
}
