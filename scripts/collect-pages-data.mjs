#!/usr/bin/env node
/**
 * Сборщик показаний датчика Tuya для GitHub Pages.
 *
 * Используется в GitHub Actions (см. .github/workflows/pages.yml):
 *   node scripts/collect-pages-data.mjs          — реальные данные (ключи из env)
 *   node scripts/collect-pages-data.mjs --mock   — тестовые данные без устройства
 *
 * Переменные окружения (реальный режим):
 *   TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, TUYA_DEVICE_ID, TUYA_REGION (us|eu|euw|cn|in)
 *
 * Результат: data/latest.json — его читает статичный дашборд (site/).
 * Сценарий не имеет зависимостей и работает на Node.js 20+ (глобальный fetch).
 */

import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOCK = process.argv.includes('--mock');

/* ------------------------------ регионы и коды ------------------------------ */

const REGION_HOSTS = {
  us: 'https://openapi.tuya.com', // Америки
  eu: 'https://openapi.tuyaeu.com', // Центральная Европа
  euw: 'https://openapi.tuyaus.com', // Западная Европа
  cn: 'https://openapi.tuya.cn', // Китай
  in: 'https://openapi.tuyain.com', // Индия
};

const TEMP_CODES = new Set(['va_temperature', 'temp_current', 'temperature', 'current_temperature', 'temp_indoor']);
const HUM_CODES = new Set(['va_humidity', 'humidity_current', 'humidity', 'current_humidity', 'humidity_value']);
const BATT_CODES = new Set(['battery_percentage', 'battery', 'battery_value', 'va_battery', 'battery_state']);

/* ------------------------------ подпись запросов ------------------------------ */

function hmacSha256HexUpper(data, secret) {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex').toUpperCase();
}

async function fetchToken(creds) {
  const host = REGION_HOSTS[creds.region];
  const t = Date.now().toString();
  const sign = hmacSha256HexUpper(creds.clientId + t, creds.clientSecret);
  const res = await fetch(`${host}/v1.0/token?grant_type=1`, {
    headers: {
      client_id: creds.clientId,
      sign,
      sign_method: 'HMAC-SHA256',
      t,
      mode: 'simple',
      access_token: '',
    },
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.success || !json.result?.access_token) {
    throw new Error(json?.msg ? `Tuya: ${json.msg}` : 'Не удалось получить токен Tuya Cloud');
  }
  return json.result.access_token;
}

async function apiGet(creds, token, pathWithQuery) {
  const host = REGION_HOSTS[creds.region];
  const t = Date.now().toString();
  const stringToSign = ['GET', pathWithQuery, '', ''].join('\n');
  const sign = hmacSha256HexUpper(creds.clientId + token + t + stringToSign, creds.clientSecret);
  const res = await fetch(`${host}${pathWithQuery}`, {
    headers: {
      client_id: creds.clientId,
      access_token: token,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
      mode: 'cors',
    },
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error('Tuya Cloud недоступен — нет ответа от сервера');
  if (!json.success) throw new Error(`Tuya: ${json.msg || 'неизвестная ошибка API'}`);
  return json.result;
}

/* ------------------------------ преобразование значений ------------------------------ */

function convertTemperature(raw) {
  let t = raw / 10;
  if (Math.abs(t) > 60) t = raw / 100;
  return Math.round(t * 10) / 10;
}

function convertHumidity(raw) {
  if (raw >= 1000) return Math.round((raw / 100) * 10) / 10;
  if (raw >= 100) return Math.round((raw / 10) * 10) / 10;
  return raw;
}

function extractReading(status) {
  let temperature = null;
  let humidity = null;
  let battery = null;
  for (const item of status ?? []) {
    const v = typeof item.value === 'string' ? Number(item.value) : item.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (temperature === null && TEMP_CODES.has(item.code)) temperature = convertTemperature(v);
    else if (humidity === null && HUM_CODES.has(item.code)) humidity = convertHumidity(v);
    else if (battery === null && BATT_CODES.has(item.code)) battery = Math.max(0, Math.min(100, Math.round(v)));
  }
  return { temperature, humidity, battery };
}

/* ------------------------------ история из журнала ------------------------------ */

async function fetchHistory(creds, token, hours = 24) {
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const params = new URLSearchParams({
    start_time: String(start),
    end_time: String(end),
    type: '7',
    size: '100',
  });
  const buckets = new Map();

  for (let page = 0; page < 30; page += 1) {
    const result = await apiGet(creds, token, `/v1.0/iot-03/devices/${creds.deviceId}/logs?${params}`);
    for (const log of result?.logs ?? []) {
      const code = typeof log.code === 'string' ? log.code : null;
      if (!code) continue;
      const raw = Number(log.value);
      if (!Number.isFinite(raw)) continue;
      let ts = Number(log.time ?? log.event_time ?? 0);
      if (!ts) continue;
      if (ts < 1e12) ts *= 1000;
      const bucket = Math.floor(ts / 60_000) * 60_000;
      const entry = buckets.get(bucket) ?? { temperature: null, humidity: null };
      if (TEMP_CODES.has(code)) entry.temperature = convertTemperature(raw);
      else if (HUM_CODES.has(code)) entry.humidity = convertHumidity(raw);
      buckets.set(bucket, entry);
    }
    if (!result?.has_more || !result?.last_row_key) break;
    params.set('last_row_key', String(result.last_row_key));
  }

  return Array.from(buckets.entries())
    .map(([ms, v]) => ({ t: new Date(ms).toISOString(), temp: v.temperature, hum: v.humidity }))
    .sort((a, b) => new Date(a.t) - new Date(b.t));
}

/* ------------------------------ утилиты ------------------------------ */

function downsample(items, max) {
  if (items.length <= max) return items;
  const step = items.length / max;
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(items[Math.floor(i * step)]);
  out[out.length - 1] = items[items.length - 1];
  return out;
}

function buildStats(history) {
  const temps = history.map((h) => h.temp).filter((v) => v !== null);
  const hums = history.map((h) => h.hum).filter((v) => v !== null);
  const agg = (arr) =>
    arr.length
      ? {
          min: Math.round(Math.min(...arr) * 10) / 10,
          avg: Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10,
          max: Math.round(Math.max(...arr) * 10) / 10,
        }
      : null;
  return { temp: agg(temps), hum: agg(hums) };
}

/* ------------------------------ mock-режим ------------------------------ */

function buildMockData() {
  const now = Date.now();
  const history = [];
  for (let i = 96; i >= 0; i -= 1) {
    const t = now - i * 15 * 60 * 1000;
    const phase = (i / 96) * Math.PI * 2;
    history.push({
      t: new Date(t).toISOString(),
      temp: Math.round((22.4 + Math.sin(phase - 1.2) * 1.6 + (Math.random() - 0.5) * 0.3) * 10) / 10,
      hum: Math.round((46 + Math.sin(phase + 0.8) * 6 + (Math.random() - 0.5) * 1.5) * 10) / 10,
    });
  }
  const last = history[history.length - 1];
  return {
    status: 'ok',
    generatedAt: new Date(now).toISOString(),
    error: null,
    mock: true,
    device: { name: 'Тестовый датчик климата', model: 'TS0201', online: true },
    current: { temperature: last.temp, humidity: last.hum, battery: 87, recordedAt: last.t },
    stats: buildStats(history),
    history: downsample(history, 400),
  };
}

/* ------------------------------ основной сценарий ------------------------------ */

function writeResult(data) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = join(root, 'data');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'latest.json');
  writeFileSync(outFile, JSON.stringify(data, null, 2));
  console.log(`OK: ${outFile}`);
}

async function collectReal() {
  const clientId = (process.env.TUYA_CLIENT_ID || '').trim();
  const clientSecret = (process.env.TUYA_CLIENT_SECRET || '').trim();
  const deviceId = (process.env.TUYA_DEVICE_ID || '').trim();
  const region = (process.env.TUYA_REGION || 'eu').trim();

  const missing = [
    !clientId && 'TUYA_CLIENT_ID',
    !clientSecret && 'TUYA_CLIENT_SECRET',
    !deviceId && 'TUYA_DEVICE_ID',
  ].filter(Boolean);
  if (missing.length) throw new Error(`Не заданы секреты GitHub: ${missing.join(', ')}`);
  if (!REGION_HOSTS[region]) throw new Error(`Неизвестный регион TUYA_REGION="${region}"`);

  const creds = { clientId, clientSecret, deviceId, region };
  const token = await fetchToken(creds);
  const detail = await apiGet(creds, token, `/v1.0/devices/${deviceId}`);

  let status = Array.isArray(detail?.status) ? detail.status : null;
  if (!status) {
    const st = await apiGet(creds, token, `/v1.0/devices/${deviceId}/status`);
    status = Array.isArray(st) ? st : (st?.list ?? []);
  }

  const reading = extractReading(status);
  let history = [];
  try {
    history = await fetchHistory(creds, token, 24);
  } catch (err) {
    console.warn(`Журнал Tuya недоступен (${err.message}) — график будет пустым`);
  }

  const now = new Date();
  return {
    status: 'ok',
    generatedAt: now.toISOString(),
    error: null,
    mock: false,
    device: {
      name: detail?.name ?? null,
      model: detail?.model ?? null,
      online: Boolean(detail?.online),
    },
    current: { ...reading, recordedAt: now.toISOString() },
    stats: buildStats(history),
    history: downsample(history, 400),
  };
}

async function main() {
  if (MOCK) {
    writeResult(buildMockData());
    return;
  }
  try {
    writeResult(await collectReal());
  } catch (err) {
    console.error(`Ошибка сбора: ${err.message}`);
    // Пишем JSON с ошибкой, чтобы страница показала причину, и выходим без падения —
    // тогда воркфлоу опубликует баннер с проблемой вместо тихо устаревших данных
    writeResult({
      status: 'error',
      generatedAt: new Date().toISOString(),
      error: err.message,
      mock: false,
      device: null,
      current: null,
      stats: null,
      history: [],
    });
    if (existsSync(join(process.cwd(), 'data', 'latest.json'))) process.exitCode = 0;
  }
}

main();
