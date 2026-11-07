#!/usr/bin/env node
/**
 * Перебор вариантов алгоритма подписи токен-запроса Tuya.
 * Ключи только через переменные окружения: TUYA_CLIENT_ID, TUYA_CLIENT_SECRET
 */
import { createHmac, createHash } from 'node:crypto';

const clientId = (process.env.TUYA_CLIENT_ID || '').trim();
const clientSecret = (process.env.TUYA_CLIENT_SECRET || '').trim();
if (!clientId || !clientSecret) {
  console.error('Нет ключей');
  process.exit(1);
}
const HOST = 'https://openapi.tuyaeu.com';
const URL_PATH = '/v1.0/token?grant_type=1';

const hmac = (key, data, up = true) =>
  createHmac('sha256', key).update(data, 'utf8').digest(up ? 'hex' : 'hex')[up ? 'toUpperCase' : 'toString']();
const sha256 = (data) => createHash('sha256').update(data, 'utf8').digest('hex').toUpperCase();

async function attempt(label, headers) {
  const t = Date.now().toString();
  const h = { client_id: clientId, sign_method: 'HMAC-SHA256', t, ...headers(t) };
  try {
    const res = await fetch(`${HOST}${URL_PATH}`, { headers: h, signal: AbortSignal.timeout(10000) });
    const json = await res.json().catch(() => null);
    const ok = json?.success && json?.result?.access_token;
    console.log(`${label.padEnd(52)} → code=${String(json?.code ?? '-').padEnd(6)} msg="${json?.msg ?? '-'}"${ok ? '  ✅✅✅ ТОКЕН ПОЛУЧЕН' : ''}`);
    return json;
  } catch (e) {
    console.log(`${label.padEnd(52)} → сеть: ${e.message}`);
    return null;
  }
}

console.log('=== ВАРИАНТЫ ПОДПИСИ (реальный ID + новый секрет, дата-центр eu) ===');

await attempt('V1: HMAC(секрет, id+t), нижний регистр', (t) => ({ sign: hmac(clientSecret, clientId + t, false), mode: 'simple', access_token: '' }));
await attempt('V2: HMAC(секрет, id+t), верхний, mode=cors', (t) => ({ sign: hmac(clientSecret, clientId + t), mode: 'cors', access_token: '' }));
await attempt('V3: HMAC(секрет, id+t), верхний, БЕЗ access_token', (t) => ({ sign: hmac(clientSecret, clientId + t), mode: 'simple' }));
await attempt('V4: HMAC(id+t, секрет) — ключ/данные наоборот', (t) => ({ sign: hmac(clientId + t, clientSecret), mode: 'simple', access_token: '' }));
await attempt('V5: HMAC(секрет, t+id) — порядок наоборот', (t) => ({ sign: hmac(clientSecret, t + clientId), mode: 'simple', access_token: '' }));
await attempt('V6: SHA256(id+t+секрет) — старая схема', (t) => ({ sign: sha256(clientId + t + clientSecret), sign_method: 'sha256', mode: 'simple', access_token: '' }));
await attempt('V7: HMAC(секрет, GET\\nпуть\\n\\n\\n)', (t) => ({ sign: hmac(clientSecret, ['GET', URL_PATH, '', ''].join('\n')), mode: 'simple', access_token: '' }));
await attempt('V8: HMAC(секрет, id+t+путь)', (t) => ({ sign: hmac(clientSecret, clientId + t + URL_PATH), mode: 'simple', access_token: '' }));
