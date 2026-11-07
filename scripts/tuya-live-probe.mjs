#!/usr/bin/env node
/**
 * Живая диагностика реальной пары ключей Tuya.
 * Ключи передаются ТОЛЬКО через переменные окружения — в коде их нет.
 *
 * Проверяет:
 *  1. Формат строк (длина, набор символов)
 *  2. Токен-запрос точной парой на указанном и остальных дата-центрах
 *  3. Эталонные варианты секрета (испорченный символ, ID вместо секрета),
 *     чтобы эмпирически узнать, какой код Tuya даёт на какую ошибку
 *
 * Env: TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, TUYA_REGION (us|eu|euw|cn|in)
 */
import { createHmac } from 'node:crypto';

const HOSTS = {
  us: 'https://openapi.tuya.com',
  eu: 'https://openapi.tuyaeu.com',
  euw: 'https://openapi.tuyaus.com',
  cn: 'https://openapi.tuya.cn',
  in: 'https://openapi.tuyain.com',
};

const clientId = (process.env.TUYA_CLIENT_ID || '').trim();
const clientSecret = (process.env.TUYA_CLIENT_SECRET || '').trim();
const region = (process.env.TUYA_REGION || 'eu').trim();

if (!clientId || !clientSecret) {
  console.error('Нет ключей в переменных окружения');
  process.exit(1);
}

function sign(data, secret) {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex').toUpperCase();
}

async function tryToken(host, id, secret, label) {
  const t = Date.now().toString();
  const s = sign(id + t, secret);
  try {
    const res = await fetch(`${host}/v1.0/token?grant_type=1`, {
      headers: {
        client_id: id,
        sign: s,
        sign_method: 'HMAC-SHA256',
        t,
        mode: 'simple',
        access_token: '',
      },
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json().catch(() => null);
    const ok = json?.success && json?.result?.access_token;
    console.log(
      `${label.padEnd(46)} → HTTP ${res.status} code=${String(json?.code ?? '-').padEnd(5)} msg="${json?.msg ?? '-'}"${ok ? '  ✅ ТОКЕН ПОЛУЧЕН' : ''}`,
    );
    return json;
  } catch (e) {
    console.log(`${label.padEnd(46)} → сеть: ${e.message}`);
    return null;
  }
}

/* 1. Формат строк */
const classes = (s) => {
  const out = [];
  if (/[a-z]/.test(s)) out.push('a-z');
  if (/[A-Z]/.test(s)) out.push('A-Z');
  if (/[0-9]/.test(s)) out.push('0-9');
  if (/[^a-zA-Z0-9]/.test(s)) out.push('ПРОЧИЕ СИМВОЛЫ!');
  return out.join(',');
};
console.log('=== ФОРМАТ СТРОК ===');
console.log(`Access ID   : длина ${clientId.length}, символы: ${classes(clientId)}`);
console.log(`Access Secret: длина ${clientSecret.length}, символы: ${classes(clientSecret)}`);
console.log(`ID и Secret совпадают? ${clientId === clientSecret ? '⚠️ ДА — так не должно быть!' : 'нет (нормально)'}`);
console.log(`Секрет валидный hex-32? ${/^[0-9a-f]{32}$/.test(clientSecret) ? 'да' : 'НЕТ'}`);

/* 2. Точная пара на всех дата-центрах */
console.log(`\n=== ТОЧНАЯ ПАРА ПО ДАТА-ЦЕНТРАМ (основной: ${region}) ===`);
for (const [name, host] of Object.entries(HOSTS)) {
  if (name === 'cn') continue; // cn часто недоступен из сети — пропускаем
  await tryToken(host, clientId, clientSecret, `[${name}] точная пара`);
}

/* 3. Эталонные варианты секрета на основном дата-центре */
console.log(`\n=== ЭТАЛОННЫЕ ВАРИАНТЫ НА [${region}] (для расшифровки кодов) ===`);
const host = HOSTS[region];
const corrupted = clientSecret.slice(0, -1) + (clientSecret.endsWith('0') ? '1' : '0');
await tryToken(host, clientId, corrupted, 'секрет с 1 изменённым символом');
await tryToken(host, clientId, clientId, 'вместо секрета подставлен Access ID');
