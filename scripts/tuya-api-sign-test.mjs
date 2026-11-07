#!/usr/bin/env node
/**
 * Проверка формулы подписи API-запросов (с токеном):
 *   stringToSign = [GET, sha256(''), '', path].join('\n')
 *   sign = HMAC(clientId + token + t + stringToSign, secret)
 * Проба: несуществующее устройство → если ошибка НЕ "sign invalid", формула верна.
 * Env: TUYA_CLIENT_ID, TUYA_CLIENT_SECRET
 */
import { createHmac, createHash } from 'node:crypto';

const clientId = (process.env.TUYA_CLIENT_ID || '').trim();
const clientSecret = (process.env.TUYA_CLIENT_SECRET || '').trim();
const HOST = 'https://openapi.tuyaeu.com';
const EMPTY = createHash('sha256').update('').digest('hex');

async function apiGet(token, path) {
  const t = Date.now().toString();
  const stringToSign = ['GET', EMPTY, '', path].join('\n');
  const sign = createHmac('sha256', clientSecret).update(clientId + token + t + stringToSign, 'utf8').digest('hex').toUpperCase();
  const res = await fetch(`${HOST}${path}`, {
    headers: { client_id: clientId, access_token: token, sign, t, sign_method: 'HMAC-SHA256', mode: 'cors' },
    signal: AbortSignal.timeout(10000),
  });
  return res.json().catch(() => null);
}

// 1. токен — полная формула
const t = Date.now().toString();
const tokUrl = '/v1.0/token?grant_type=1';
const tokStr = clientId + t + ['GET', EMPTY, '', tokUrl].join('\n');
const tokSign = createHmac('sha256', clientSecret).update(tokStr, 'utf8').digest('hex').toUpperCase();
const tokRes = await fetch(`${HOST}${tokUrl}`, {
  headers: { client_id: clientId, sign: tokSign, sign_method: 'HMAC-SHA256', t, mode: 'simple', access_token: '' },
  signal: AbortSignal.timeout(10000),
});
const tokJson = await tokRes.json().catch(() => null);
const token = tokJson?.result?.access_token;
console.log(token ? '✅ Токен получен' : `❌ Токен не получен: ${JSON.stringify(tokJson)}`);
if (!token) process.exit(1);

// 2. API-запрос с фейковым ID устройства: ожидаем ошибку "устройство не найдено", НЕ "sign invalid"
const probe = await apiGet(token, '/v1.0/devices/zzzzfakeid9999');
console.log(`Проба несуществующего устройства → code=${probe?.code} msg="${probe?.msg}"`);
console.log(
  probe?.code && probe.code !== 1004
    ? '✅ Формула подписи API-запросов ВЕРНА (сервер проверил права, а не подпись)'
    : '❌ Формула подписи API-запросов неверна (снова sign invalid)',
);
