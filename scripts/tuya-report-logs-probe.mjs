#!/usr/bin/env node
/**
 * Проба report-logs после подписки сервиса Device Log Query.
 * Проверяет: токен → статус устройства → /report-logs → (для сравнения) /logs.
 * Выводит полное тело каждого ответа, чтобы увидеть 28841101 или успех.
 *
 * Ключи только через env:
 *   TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, TUYA_REGION, TUYA_DEVICE_ID
 */

import { createHash, createHmac } from 'node:crypto';

const HOSTS = {
  us: 'https://openapi.tuya.com',
  eu: 'https://openapi.tuyaeu.com',
  euw: 'https://openapi.tuyaus.com',
  cn: 'https://openapi.tuya.cn',
  in: 'https://openapi.tuyain.com',
};

const EMPTY_BODY_SHA = createHash('sha256').update('').digest('hex');
const secret = process.env.TUYA_CLIENT_SECRET || '';
const clientId = process.env.TUYA_CLIENT_ID || '';
const region = process.env.TUYA_REGION || 'eu';
const deviceId = process.env.TUYA_DEVICE_ID || '';
const host = HOSTS[region];

function sign(data) {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex').toUpperCase();
}

function canonicalUrl(pathWithQuery) {
  const q = pathWithQuery.indexOf('?');
  if (q === -1) return pathWithQuery;
  const path = pathWithQuery.slice(0, q);
  const pairs = pathWithQuery.slice(q + 1).split('&').filter(Boolean);
  pairs.sort((a, b) => {
    const ka = a.indexOf('=') === -1 ? a : a.slice(0, a.indexOf('='));
    const kb = b.indexOf('=') === -1 ? b : b.slice(0, b.indexOf('='));
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return `${path}?${pairs.join('&')}`;
}

async function get(pathWithQuery, token = '') {
  const url = canonicalUrl(pathWithQuery);
  const t = Date.now().toString();
  const stringToSign = ['GET', EMPTY_BODY_SHA, '', url].join('\n');
  const signStr = token ? clientId + token + t + stringToSign : clientId + t + stringToSign;
  const res = await fetch(`${host}${url}`, {
    headers: {
      client_id: clientId,
      access_token: token,
      sign: sign(signStr),
      t,
      sign_method: 'HMAC-SHA256',
      mode: token ? 'cors' : 'simple',
    },
    signal: AbortSignal.timeout(15000),
  });
  return res.json().catch(() => ({ parse_error: true }));
}

async function main() {
  console.log(`Регион: ${region} → ${host}`);
  const tokenRes = await get('/v1.0/token?grant_type=1');
  console.log('Токен:', JSON.stringify(tokenRes));
  const token = tokenRes?.result?.access_token;
  if (!token) process.exit(1);

  console.log(`\nСтатус устройства ${deviceId}:`);
  console.log(JSON.stringify(await get(`/v1.0/devices/${deviceId}/status`, token)));

  const end = Date.now();
  const start = end - 24 * 3600 * 1000;
  const rlParams = new URLSearchParams({
    start_time: String(start),
    end_time: String(end),
    size: '100',
  });
  console.log('\nreport-logs (/v1.0/iot-03/devices/{id}/report-logs):');
  const rl = await get(`/v1.0/iot-03/devices/${deviceId}/report-logs?${rlParams}`, token);
  const list = rl?.result?.list ?? rl?.result?.logs;
  console.log(JSON.stringify({ success: rl?.success, code: rl?.code, msg: rl?.msg, total: rl?.result?.total, has_more: rl?.result?.has_more }));
  if (Array.isArray(list)) {
    const codes = {};
    for (const row of list) codes[row.code] = (codes[row.code] ?? 0) + 1;
    console.log(`  строк в первой странице: ${list.length}; счётчик по кодам:`, JSON.stringify(codes));
    console.log('  пример первой записи:', JSON.stringify(list[0]));
  } else if (rl?.success) {
    console.log('  тело ответа:', JSON.stringify(rl).slice(0, 800));
  }
}

main().catch((e) => {
  console.error('Ошибка пробы:', e.message);
  process.exit(1);
});
