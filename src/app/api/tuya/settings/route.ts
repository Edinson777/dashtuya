import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { buildState } from '@/lib/state';
import {
  extractReading,
  fetchDeviceHistory,
  getDeviceInfo,
  isTuyaRegion,
  type TuyaCredentials,
  type TuyaRegion,
} from '@/lib/tuya';
import { insertReadingsDeduped, pruneOldReadings } from '@/lib/tuyaStore';

export const dynamic = 'force-dynamic';

interface SettingsBody {
  clientId?: string;
  clientSecret?: string;
  deviceId?: string;
  region?: string;
  forget?: boolean;
}

const ERR_BAD = { error: 'Заполните Access ID, Access Secret и ID устройства' };

/**
 * Сохраняет настройки подключения. Пустые поля (кроме региона) не перезаписывают
 * старые значения — так секреты не нужно вводить повторно при правке ID устройства.
 * Ключи сохраняются всегда (даже при ошибке проверки), чтобы их не пришлось
 * вводить заново из-за временной недоступности облака.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as SettingsBody | null;

    // «Забыть устройство»: чистит настройки и локальную историю
    if (body?.forget) {
      await db.settings.deleteMany({});
      await db.reading.deleteMany({});
      return NextResponse.json({ ok: true, state: await buildState() });
    }

    const existing = await db.settings.findUnique({ where: { id: 1 } });

    const clientId = (body?.clientId || existing?.clientId || '').trim();
    const clientSecret = (body?.clientSecret || existing?.clientSecret || '').trim();
    const deviceId = (body?.deviceId || existing?.deviceId || '').trim();
    const region = (body?.region || existing?.region || 'eu').trim();

    if (!clientId || !clientSecret || !deviceId) {
      return NextResponse.json(ERR_BAD, { status: 400 });
    }
    if (!isTuyaRegion(region)) {
      return NextResponse.json({ error: 'Выберите регион дата-центра Tuya' }, { status: 400 });
    }

    const creds: TuyaCredentials = {
      clientId,
      clientSecret,
      deviceId,
      region: region as TuyaRegion,
    };

    let warning: string | null = null;
    let deviceInfo = null;

    try {
      deviceInfo = await getDeviceInfo(creds);
    } catch (error) {
      warning =
        error instanceof Error
          ? error.message
          : 'Подключение не удалось — проверьте ключи и ID устройства';
    }

    await db.settings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        clientId,
        clientSecret,
        deviceId,
        region,
        deviceName: deviceInfo?.name ?? null,
        deviceModel: deviceInfo?.model ?? null,
        deviceOnline: deviceInfo?.online ?? null,
        lastSyncAt: deviceInfo ? new Date() : null,
      },
      update: {
        clientId,
        clientSecret,
        deviceId,
        region,
        deviceName: deviceInfo?.name ?? existing?.deviceName ?? null,
        deviceModel: deviceInfo?.model ?? existing?.deviceModel ?? null,
        deviceOnline: deviceInfo ? deviceInfo.online : (existing?.deviceOnline ?? null),
        lastSyncAt: deviceInfo ? new Date() : (existing?.lastSyncAt ?? null),
      },
    });

    if (deviceInfo) {
      const reading = extractReading(deviceInfo.status);
      if (
        reading.temperature !== null ||
        reading.humidity !== null ||
        reading.battery !== null
      ) {
        await db.reading.create({
          data: { recordedAt: new Date(), ...reading, source: 'manual' },
        });
      }

      // Подтягиваем журнал за 24 часа, чтобы график сразу был содержательным
      try {
        const history = await fetchDeviceHistory(creds, 24);
        await insertReadingsDeduped(history, 'sync');
      } catch (error) {
        console.error('[api/tuya/settings] backfill:', error);
      }
      await pruneOldReadings().catch(() => undefined);
    }

    return NextResponse.json({
      ok: !warning,
      warning,
      state: await buildState(),
    });
  } catch (error) {
    console.error('[api/tuya/settings]', error);
    return NextResponse.json({ error: 'Внутренняя ошибка при сохранении настроек' }, { status: 500 });
  }
}
