/**
 * Тест-сид: заполняет базу фиктивными настройками и историей за 24 часа,
 * чтобы проверить рендер дашборда без реального устройства Tuya.
 * Запуск: bun scripts/seed-test.mjs
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const now = Date.now();
const readings = [];
for (let i = 96; i >= 0; i -= 1) {
  const t = now - i * 15 * 60 * 1000; // каждые 15 минут
  const phase = (i / 96) * Math.PI * 2;
  const temp = 22.4 + Math.sin(phase - 1.2) * 1.6 + (Math.random() - 0.5) * 0.3;
  const hum = 46 + Math.sin(phase + 0.8) * 6 + (Math.random() - 0.5) * 1.5;
  readings.push({
    recordedAt: new Date(t),
    temperature: Math.round(temp * 10) / 10,
    humidity: Math.round(hum * 10) / 10,
    battery: 87,
    source: 'sync',
  });
}

await db.reading.deleteMany({});
await db.settings.deleteMany({});
await db.reading.createMany({ data: readings });
await db.settings.create({
  data: {
    id: 1,
    clientId: 'test-access-id-0000',
    clientSecret: 'test-access-secret-0000',
    deviceId: 'eb000000testdeviceid0000',
    region: 'eu',
    deviceName: 'Тестовый датчик климата',
    deviceModel: 'TS0201',
    deviceOnline: true,
    lastSyncAt: new Date(now),
  },
});

const count = await db.reading.count();
console.log(`Засеяно ${count} показаний + тестовые настройки`);
await db.$disconnect();
