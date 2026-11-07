#!/usr/bin/env node
/**
 * Точечная проверка: один токен-запрос на eu, печать ПОЛНОГО ответа Tuya.
 * Ключи только через переменные окружения.
 * Env: TUYA_CLIENT_ID, TUYA_CLIENT_SECRET
 */
import { createHmac } from 'node:crypto';

const clientId = (process.env.TUYA_CLIENT_ID || '').trim();
const clientSecret = (process.env.TUYA_CLIENT_SECRET || '').trim();
if (!clientId || !clientSecret) {
  console.error('Нет ключей в окружении');
  process.exit(1);
}

const t = Date.now().toString();
const sign = createHmac('sha256', clientSecret).update(clientId + t, 'utf8').digest('hex').toUpperCase();

const res = await fetch('https://openapi.tuyaeu.com/v1.0/token?grant_type=1', {
  headers: {
    client_id: clientId,
    sign,
    sign_method: 'HMAC-SHA256',
    t,
    mode: 'simple',
    access_token: '',
  },
  signal: AbortSignal.timeout(10000),
});
console.log(`HTTP ${res.status}`);
const text = await res.text();
console.log('Тело ответа:', text);
