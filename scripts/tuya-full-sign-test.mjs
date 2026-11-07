#!/usr/bin/env node
/**
 * Проверка «полной» формулы подписи токена из официального примера Tuya:
 *   signStr = clientId + t + [GET, sha256(''), '', '/v1.0/token?grant_type=1'].join('\n')
 *   sign    = HMAC-SHA256(signStr, secret), верхний hex
 * Тестируются ОБЕ пары (старый секрет со скриншота и новый после Reset).
 * Ключи только через переменные окружения TUYA_CLIENT_ID / TUYA_SECRET_OLD / TUYA_SECRET_NEW.
 */
import { createHmac, createHash } from 'node:crypto';

const clientId = (process.env.TUYA_CLIENT_ID || '').trim();
const oldSecret = (process.env.TUYA_SECRET_OLD || '').trim();
const newSecret = (process.env.TUYA_SECRET_NEW || '').trim();
if (!clientId || !(oldSecret || newSecret)) {
  console.error('Нет ключей');
  process.exit(1);
}

const HOST = 'https://openapi.tuyaeu.com';
const SIGN_URL = '/v1.0/token?grant_type=1';
const EMPTY_BODY_SHA = createHash('sha256').update('').digest('hex'); // sha256 пустого тела

async function tryFullFormula(secret, label) {
  const t = Date.now().toString();
  const stringToSign = ['GET', EMPTY_BODY_SHA, '', SIGN_URL].join('\n');
  const signStr = clientId + t + stringToSign;
  const sign = createHmac('sha256', secret).update(signStr, 'utf8').digest('hex').toUpperCase();
  try {
    const res = await fetch(`${HOST}${SIGN_URL}`, {
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
    const json = await res.json().catch(() => null);
    const ok = json?.success && json?.result?.access_token;
    console.log(`${label.padEnd(44)} → code=${String(json?.code ?? '-').padEnd(6)} msg="${json?.msg ?? '-'}"${ok ? '  ✅✅✅ ТОКЕН ПОЛУЧЕН!' : ''}`);
    return json;
  } catch (e) {
    console.log(`${label.padEnd(44)} → сеть: ${e.message}`);
    return null;
  }
}

console.log('=== ПОЛНАЯ ФОРМУЛА ПОДПИСИ (как в официальном примере Tuya) ===');
console.log(`sha256('') = ${EMPTY_BODY_SHA.slice(0, 16)}...`);
if (newSecret) await tryFullFormula(newSecret, 'НОВЫЙ секрет (после Reset)');
if (oldSecret) await tryFullFormula(oldSecret, 'СТАРЫЙ секрет (со скриншота)');
