#!/usr/bin/env node
/**
 * Тесты конверсий розетки с энергомониторингом.
 * Проверяет BOTH копии логики: scripts/collect-pages-data.mjs (ESM, GitHub Pages)
 * и vercel/api/readings.js (CommonJS, Vercel) — они должны давать одинаковые числа.
 *
 * Запуск: node scripts/test-plug-conversions.mjs
 */

import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import {
  extractReading,
  detectType,
  convertPower,
  convertVoltage,
  convertCurrent,
  convertEnergy,
  buildStats,
} from './collect-pages-data.mjs';

const require = createRequire(import.meta.url);
const vercel = require('../vercel/api/readings.js');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
}

/* ---------- 1. конверсии единиц ---------- */

console.log('\nКонверсии единиц:');

check('convertPower: 1523 → 152.3 Вт (стандарт 0,1 Вт)', () => {
  assert.equal(convertPower(1523), 152.3);
});
check('convertPower: 50000 → 500 Вт (подстройка разряда)', () => {
  assert.equal(convertPower(50000), 500);
});
check('convertPower: 0 → 0 Вт (выключено)', () => {
  assert.equal(convertPower(0), 0);
});
check('convertVoltage: 2276 → 227.6 В', () => {
  assert.equal(convertVoltage(2276), 227.6);
});
check('convertVoltage: 230 → 230 В (масштаб 1:1)', () => {
  assert.equal(convertVoltage(230), 230);
});
check('convertVoltage: 22800 → 228 В (масштаб 0,01)', () => {
  assert.equal(convertVoltage(22800), 228);
});
check('convertCurrent: 830 мА → 0.83 А', () => {
  assert.equal(convertCurrent(830), 0.83);
});
check('convertCurrent: 230000 → 23 А (подстройка разряда)', () => {
  assert.equal(convertCurrent(230000), 23);
});
check('convertEnergy: 245097 → 2450.97 кВт·ч (0,01 кВт·ч)', () => {
  assert.equal(convertEnergy(245097), 2450.97);
});

/* ---------- 2. распознавание статуса ---------- */

const plugStatus = [
  { code: 'switch_1', value: true },
  { code: 'cur_power', value: '1523' },
  { code: 'cur_voltage', value: '2276' },
  { code: 'cur_current', value: '830' },
  { code: 'add_ele', value: 245097 },
  { code: 'day_ele', value: 1230 },
];

const expectedPlug = {
  temperature: null,
  humidity: null,
  battery: null,
  on: true,
  power: 152.3,
  voltage: 227.6,
  current: 0.83,
  energyTotal: 2450.97,
  energyToday: 12.3,
};

const climateStatus = [
  { code: 'va_temperature', value: 235 },
  { code: 'va_humidity', value: 460 },
  { code: 'battery_percentage', value: 87 },
];

console.log('\nРаспознавание статуса:');

check('розетка: все поля извлечены (строки и числа)', () => {
  assert.deepEqual(extractReading(plugStatus), expectedPlug);
});
check('розетка: тип «plug»', () => {
  assert.equal(detectType(plugStatus), 'plug');
});
check('климат: тип «climate», поля розетки пустые', () => {
  const r = extractReading(climateStatus);
  assert.deepEqual(r, {
    temperature: 23.5,
    humidity: 46,
    battery: 87,
    on: null,
    power: null,
    voltage: null,
    current: null,
    energyTotal: null,
    energyToday: null,
  });
  assert.equal(detectType(climateStatus), 'climate');
});
check('выключенная розетка: on=false, мощность 0 Вт', () => {
  const r = extractReading([
    { code: 'switch_1', value: false },
    { code: 'cur_power', value: 0 },
    { code: 'cur_voltage', value: 2276 },
  ]);
  assert.equal(r.on, false);
  assert.equal(r.power, 0);
  assert.equal(r.voltage, 227.6);
});
check('пустой статус: тип «unknown»', () => {
  assert.equal(detectType([]), 'unknown');
});

/* ---------- 3. статистика ---------- */

const hist = [
  { t: '2026-01-01T00:00:00Z', temp: null, hum: null, power: 100, energy: 10.5 },
  { t: '2026-01-01T01:00:00Z', temp: null, hum: null, power: 200, energy: 11.25 },
  { t: '2026-01-01T02:00:00Z', temp: null, hum: null, power: 300, energy: 12.0 },
];

console.log('\nСтатистика:');

check('мин/ср/макс мощности + прирост энергии 1.5 кВт·ч', () => {
  assert.deepEqual(buildStats(hist), {
    temp: null,
    hum: null,
    power: { min: 100, avg: 200, max: 300 },
    energyDelta: 1.5,
  });
});
check('сброс счётчика → energyDelta null', () => {
  const s = buildStats([
    { t: '2026-01-01T00:00:00Z', power: 100, energy: 500 },
    { t: '2026-01-01T01:00:00Z', power: 100, energy: 2 },
  ]);
  assert.equal(s.energyDelta, null);
});

/* ---------- 4. паритет Vercel-копии ---------- */

console.log('\nПаритет Vercel-копии (vercel/api/readings.js):');

check('extractReading даёт те же числа', () => {
  assert.deepEqual(vercel.extractReading(plugStatus), expectedPlug);
  assert.deepEqual(vercel.extractReading(climateStatus), extractReading(climateStatus));
});
check('detectType совпадает', () => {
  assert.equal(vercel.detectType(plugStatus), 'plug');
  assert.equal(vercel.detectType(climateStatus), 'climate');
  assert.equal(vercel.detectType([]), 'unknown');
});
check('конверсии совпадают', () => {
  assert.equal(vercel.convertPower(1523), 152.3);
  assert.equal(vercel.convertVoltage(2276), 227.6);
  assert.equal(vercel.convertCurrent(830), 0.83);
  assert.equal(vercel.convertEnergy(245097), 2450.97);
});
check('buildStats совпадает', () => {
  assert.deepEqual(vercel.buildStats(hist), buildStats(hist));
});

/* ---------- 5. mock-ответ Vercel-функции ---------- */

console.log('\nMock-ответ Vercel-функции:');

await check('mock=1: розетка присутствует и валидна', async () => {
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await vercel({ url: 'http://localhost/api/readings?mock=1' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sensors.length, 4);
  const plug = res.body.sensors.find((s) => s.type === 'plug');
  assert.ok(plug, 'нет секции с type=plug');
  assert.equal(plug.id, 'mock-plug');
  assert.equal(plug.current.on, plug.current.power > 0);
  assert.ok(Number.isFinite(plug.current.power));
  assert.ok(Number.isFinite(plug.current.energyTotal));
  assert.ok(plug.stats.power !== null, 'нет статистики мощности');
  assert.ok(plug.history.length > 0, 'история пуста');
  assert.ok(plug.history.every((h) => typeof h.power === 'number'), 'в истории нет power');
});

/* ---------- итог ---------- */

console.log(`\nИтого: ${passed} прошло, ${failed} упало`);
if (failed > 0) process.exit(1);
