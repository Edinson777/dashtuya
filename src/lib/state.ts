import { db } from '@/lib/db';
import { isTuyaRegion, REGION_LABELS } from '@/lib/tuya';

export interface HistoryDto {
  recordedAt: string;
  temperature: number | null;
  humidity: number | null;
  battery: number | null;
}

export interface PageState {
  configured: boolean;
  current: {
    temperature: number | null;
    humidity: number | null;
    battery: number | null;
    recordedAt: string;
  } | null;
  history: HistoryDto[];
  device: {
    id: string;
    name: string | null;
    model: string | null;
    online: boolean | null;
    region: string | null;
    regionLabel: string | null;
  } | null;
  lastSyncAt: string | null;
  clientIdMasked: string | null;
  secretSet: boolean;
}

function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const head = value.slice(0, 4);
  return `${head}${'•'.repeat(Math.max(4, Math.min(12, value.length - 4)))}`;
}

/** Не более max точек: равномерная прореживающая выборка с сохранением последней */
function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(items[Math.floor(i * step)]);
  const last = items[items.length - 1];
  if (out.length > 0 && out[out.length - 1] !== last) out[out.length - 1] = last;
  return out;
}

/**
 * Собирает состояние для страницы: текущие показания, история за 24 ч,
 * информация об устройстве и маскированные настройки.
 * Работает только по локальной базе — без внешних запросов (быстро и офлайн-безопасно).
 */
export async function buildState(): Promise<PageState> {
  const settings = await db.settings.findUnique({ where: { id: 1 } });

  const configured = Boolean(
    settings?.clientId && settings?.clientSecret && settings?.deviceId && settings?.region,
  );

  const since = new Date(Date.now() - 24 * 3_600_000);
  const readings = await db.reading.findMany({
    where: { recordedAt: { gte: since } },
    orderBy: { recordedAt: 'asc' },
  });

  const currentRow = readings.length > 0 ? readings[readings.length - 1] : null;

  return {
    configured,
    current: currentRow
      ? {
          temperature: currentRow.temperature,
          humidity: currentRow.humidity,
          battery: currentRow.battery,
          recordedAt: currentRow.recordedAt.toISOString(),
        }
      : null,
    history: downsample(
      readings.map((r) => ({
        recordedAt: r.recordedAt.toISOString(),
        temperature: r.temperature,
        humidity: r.humidity,
        battery: r.battery,
      })),
      400,
    ),
    device: settings?.deviceId
      ? {
          id: settings.deviceId,
          name: settings.deviceName ?? null,
          model: settings.deviceModel ?? null,
          online: settings.deviceOnline ?? null,
          region: settings.region ?? null,
          regionLabel:
            settings.region && isTuyaRegion(settings.region)
              ? REGION_LABELS[settings.region]
              : (settings.region ?? null),
        }
      : null,
    lastSyncAt: settings?.lastSyncAt ? settings.lastSyncAt.toISOString() : null,
    clientIdMasked: maskSecret(settings?.clientId),
    secretSet: Boolean(settings?.clientSecret),
  };
}
