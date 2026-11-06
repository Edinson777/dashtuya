/**
 * Serverless-функция Vercel: живой опрос Tuya Cloud.
 *
 * GET /api/readings        — текущие показания + история за 24 часа из журнала устройства
 * GET /api/readings?mock=1 — тестовые данные без устройства (для проверки деплоя)
 *
 * Переменные окружения проекта Vercel:
 *   TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, TUYA_DEVICE_ID, TUYA_REGION (us|eu|euw|cn|in)
 *
 * Формат ответа полностью совпадает с data/latest.json из GitHub Pages-версии,
 * поэтому дашборд (app.js) работает без изменений. База данных не нужна:
 * история каждый раз тянется напрямую из журнала Tuya Cloud.
 *
 * Без зависимостей, Node.js 18+ (глобальный fetch).
 */

const { createHmac } = require('node:crypto');

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

/* Лимит страниц журнала: 15 × 100 записей хватает на 24 ч типичного датчика
   (отчёт раз в 5–15 минут) и остаётся запас по таймауту serverless-функции. */
const MAX_LOG_PAGES = 15;

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

  for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
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

/* ------------------------------ агрегаты ------------------------------ */

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

/* ------------------------------ сбор реальных данных ------------------------------ */

function readCreds() {
  const clientId = (process.env.TUYA_CLIENT_ID || '').trim();
  const clientSecret = (process.env.TUYA_CLIENT_SECRET || '').trim();
  const deviceId = (process.env.TUYA_DEVICE_ID || '').trim();
  const region = (process.env.TUYA_REGION || 'eu').trim();

  const missing = [
    !clientId && 'TUYA_CLIENT_ID',
    !clientSecret && 'TUYA_CLIENT_SECRET',
    !deviceId && 'TUYA_DEVICE_ID',
  ].filter(Boolean);
  if (missing.length) {
    const err = new Error(`Не заданы переменные окружения Vercel: ${missing.join(', ')}`);
    err.code = 'CONFIG';
    throw err;
  }
  if (!REGION_HOSTS[region]) {
    const err = new Error(`Неизвестный регион TUYA_REGION="${region}" (допустимо: us, eu, euw, cn, in)`);
    err.code = 'CONFIG';
    throw err;
  }
  return { clientId, clientSecret, deviceId, region };
}

async function collectReal() {
  const creds = readCreds();
  const token = await fetchToken(creds);
  const detail = await apiGet(creds, token, `/v1.0/devices/${creds.deviceId}`);

  let status = Array.isArray(detail?.status) ? detail.status : null;
  if (!status) {
    const st = await apiGet(creds, token, `/v1.0/devices/${creds.deviceId}/status`);
    status = Array.isArray(st) ? st : (st?.list ?? []);
  }

  const reading = extractReading(status);
  let history = [];
  try {
    history = await fetchHistory(creds, token, 24);
  } catch (err) {
    // журнал не критичен: карточки значений должны работать и без графика
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

function errorPayload(message) {
  return {
    status: 'error',
    generatedAt: new Date().toISOString(),
    error: message,
    mock: false,
    device: null,
    current: null,
    stats: null,
    history: [],
  };
}

/* ------------------------------ обработчик ------------------------------ */

module.exports = async function handler(req, res) {
  // кэш на edge Vercel: повторные обращения в течение 5 минут не тратят квоту Tuya API
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    if (new URL(req.url, 'http://localhost').searchParams.has('mock')) {
      res.status(200).json(buildMockData());
      return;
    }
    res.status(200).json(await collectReal());
  } catch (err) {
    console.error(`Ошибка сбора: ${err.message}`);
    // 200 + status:"error" — дашборд покажет баннер с причиной вместо HTTP-ошибки
    res.status(200).json(errorPayload(err.message));
  }
};
