import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { buildState } from '@/lib/state';
import {
  extractReading,
  fetchDeviceHistory,
  getDeviceInfo,
  isTuyaRegion,
  TuyaError,
  type TuyaCredentials,
  type TuyaRegion,
} from '@/lib/tuya';
import { insertReadingsDeduped, pruneOldReadings } from '@/lib/tuyaStore';

export const dynamic = 'force-dynamic';

/** Ручное обновление: запрашивает свежие показания из Tuya Cloud и пишет их в базу */
export async function POST() {
  try {
    const settings = await db.settings.findUnique({ where: { id: 1 } });
    if (!settings?.clientId || !settings?.clientSecret || !settings?.deviceId) {
      return NextResponse.json(
        { error: 'Сначала укажите настройки подключения к Tuya' },
        { status: 400 },
      );
    }

    const creds: TuyaCredentials = {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      deviceId: settings.deviceId,
      region: (isTuyaRegion(settings.region) ? settings.region : 'eu') as TuyaRegion,
    };

    const info = await getDeviceInfo(creds);
    const reading = extractReading(info.status);

    if (reading.temperature !== null || reading.humidity !== null || reading.battery !== null) {
      await db.reading.create({
        data: { recordedAt: new Date(), ...reading, source: 'manual' },
      });
    }

    await db.settings.update({
      where: { id: 1 },
      data: {
        deviceName: info.name,
        deviceModel: info.model,
        deviceOnline: info.online,
        lastSyncAt: new Date(),
      },
    });

    // Догоняем журнал за 24 ч — датчик мог отправлять отчёты, пока страница была закрыта
    try {
      const history = await fetchDeviceHistory(creds, 24);
      await insertReadingsDeduped(history, 'sync');
    } catch (error) {
      console.error('[api/tuya/refresh] backfill:', error);
    }
    await pruneOldReadings().catch(() => undefined);

    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (error) {
    console.error('[api/tuya/refresh]', error);
    const message =
      error instanceof TuyaError
        ? error.message
        : 'Не удалось получить показания из Tuya Cloud — попробуйте ещё раз';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
