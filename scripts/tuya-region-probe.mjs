#!/usr/bin/env node
/**
 * Диагностика: как Tuya отвечает на каждом дата-центре для
 * несуществующего clientId и для правильного формата ключей.
 * Помогает отличить «неверный секрет» от «неверный регион».
 * Ничего секретного не содержит — только фиктивные значения.
 */
import { createHmac } from 'node:crypto';

const HOSTS = {
  us: 'https://openapi.tuya.com',
  eu: 'https://openapi.tuyaeu.com',
  euw: 'https://openapi.tuyaus.com',
  cn: 'https://openapi.tuya.cn',
  in: 'https://openapi.tuyain.com',
};

const FAKE_ID = 'a1b2c3d4e5f6a7b8c9d0'; // несуществующий Access ID (20 символов)
const FAKE_SECRET = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

function sign(data, secret) {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex').toUpperCase();
}

async function probe(name, host, clientId, secret, label) {
  const t = Date.now().toString();
  const s = sign(clientId + t, secret);
  try {
    const res = await fetch(`${host}/v1.0/token?grant_type=1`, {
      headers: {
        client_id: clientId,
        sign: s,
        sign_method: 'HMAC-SHA256',
        t,
        mode: 'simple',
        access_token: '',
      },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => null);
    console.log(`${label.padEnd(4)} ${host}  →  HTTP ${res.status}  code=${json?.code ?? '-'}  msg="${json?.msg ?? 'нет ответа'}"`);
  } catch (e) {
    console.log(`${label.padEnd(4)} ${host}  →  ошибка сети: ${e.message}`);
  }
}

console.log(`--- Тест 1: несуществующий clientId на всех 5 дата-центрах (секрет: фиктивный) ---`);
for (const [name, host] of Object.entries(HOSTS)) {
  await probe(name, host, FAKE_ID, FAKE_SECRET, name);
}

console.log(`\n--- Тест 2: тот же запрос повторно, чтобы исключить блокировки по частоте ---`);
await probe('eu', HOSTS.eu, FAKE_ID, FAKE_SECRET, 'eu');

console.log('\nВывод: если несуществующий ID везде даёт "clientId is invalid",');
console.log('то ответ "sign invalid" у пользователя означает, что Access ID существует');
console.log('на выбранном дата-центре, но секрет не совпадает (или ID/Secret из разных проектов).');
