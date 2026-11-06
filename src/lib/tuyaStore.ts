import { db } from '@/lib/db';
import type { HistoryPoint } from '@/lib/tuya';

/**
 * Сохраняет точки истории, пропуская те, рядом с которыми (±60 с)
 * уже есть запись — чтобы ручное обновление и журнал Tuya не дублировались.
 */
export async function insertReadingsDeduped(
  points: HistoryPoint[],
  source: string,
): Promise<number> {
  if (points.length === 0) return 0;

  const times = points.map((p) => p.recordedAt.getTime());
  const minTs = Math.min(...times);
  const existing = await db.reading.findMany({
    where: { recordedAt: { gte: new Date(minTs - 60_000) } },
    select: { recordedAt: true },
  });
  const existingTs = existing.map((r) => r.recordedAt.getTime());
  const fresh = points.filter(
    (p) => !existingTs.some((ts) => Math.abs(ts - p.recordedAt.getTime()) < 60_000),
  );
  if (fresh.length === 0) return 0;

  await db.reading.createMany({
    data: fresh.map((p) => ({
      recordedAt: p.recordedAt,
      temperature: p.temperature,
      humidity: p.humidity,
      battery: p.battery,
      source,
    })),
  });
  return fresh.length;
}

/** Чистит историю старше 7 дней, чтобы база не росла бесконечно */
export async function pruneOldReadings(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 3_600_000);
  await db.reading.deleteMany({ where: { recordedAt: { lt: cutoff } } });
}
