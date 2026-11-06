import crypto from 'crypto';

/**
 * Клиент Tuya IoT Cloud API (OpenAPI).
 * Подпись запросов — HMAC-SHA256 по схеме Tuya:
 *   токен:      sign = HMAC(client_id + t, secret)
 *   запросы:    sign = HMAC(client_id + access_token + t + method\npath\nheaders\nbody, secret)
 * Документация: https://developer.tuya.com/en/docs/iot/api-request
 */

export type TuyaRegion = 'us' | 'eu' | 'euw' | 'cn' | 'in';

export const REGION_HOSTS: Record<TuyaRegion, string> = {
  us: 'https://openapi.tuya.com', // Америки
  eu: 'https://openapi.tuyaeu.com', // Центральная Европа
  euw: 'https://openapi.tuyaus.com', // Западная Европа
  cn: 'https://openapi.tuya.cn', // Китай
  in: 'https://openapi.tuyain.com', // Индия
};

export const REGION_LABELS: Record<TuyaRegion, string> = {
  us: 'Америки — openapi.tuya.com',
  eu: 'Центральная Европа — openapi.tuyaeu.com',
  euw: 'Западная Европа — openapi.tuyaus.com',
  cn: 'Китай — openapi.tuya.cn',
  in: 'Индия — openapi.tuyain.com',
};

export function isTuyaRegion(value: unknown): value is TuyaRegion {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REGION_HOSTS, value);
}

/** Стандартные DP-коды датчиков климата Tuya */
const TEMP_CODES = new Set([
  'va_temperature',
  'temp_current',
  'temperature',
  'current_temperature',
  'temp_indoor',
]);
const HUM_CODES = new Set([
  'va_humidity',
  'humidity_current',
  'humidity',
  'current_humidity',
  'humidity_value',
]);
const BATT_CODES = new Set([
  'battery_percentage',
  'battery',
  'battery_value',
  'va_battery',
  'battery_state',
]);

export interface TuyaCredentials {
  clientId: string;
  clientSecret: string;
  deviceId: string;
  region: TuyaRegion;
}

export interface TuyaStatusItem {
  code: string;
  value: unknown;
}

export interface DeviceInfo {
  id: string;
  name: string | null;
  model: string | null;
  online: boolean;
  status: TuyaStatusItem[];
}

export interface SensorReading {
  temperature: number | null;
  humidity: number | null;
  battery: number | null;
}

export interface HistoryPoint {
  recordedAt: Date;
  temperature: number | null;
  humidity: number | null;
  battery: number | null;
}

export class TuyaError extends Error {
  code?: number | string;
  constructor(message: string, code?: number | string) {
    super(message);
    this.name = 'TuyaError';
    this.code = code;
  }
}

/* ----------------------------- подпись и токен ----------------------------- */

interface TokenEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenEntry>();

function hmacSha256HexUpper(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex').toUpperCase();
}

async function fetchToken(creds: TuyaCredentials): Promise<string> {
  const host = REGION_HOSTS[creds.region];
  const cacheKey = `${creds.region}:${creds.clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

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
  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: { access_token?: string; expire?: number }; msg?: string; code?: number }
    | null;

  if (!json || !json.success || !json.result?.access_token) {
    throw new TuyaError(
      json?.msg ? `Tuya: ${json.msg}` : 'Не удалось получить токен Tuya Cloud',
      json?.code,
    );
  }
  const expireMs = (json.result.expire ?? 3600) * 1000;
  tokenCache.set(cacheKey, {
    token: json.result.access_token,
    expiresAt: Date.now() + expireMs - 60_000,
  });
  return json.result.access_token;
}

interface TuyaResponse<T> {
  success?: boolean;
  result?: T;
  msg?: string;
  code?: number | string;
}

/** Перевод типовых ошибок Tuya на понятные подсказки */
function translateError(msg: string | undefined, code: number | string | undefined): string {
  const m = (msg || '').toLowerCase();
  if (m.includes('sign error') || code === 1004)
    return 'Неверная подпись запроса — проверьте Access ID и Access Secret';
  if (code === 1001 || m.includes('client id') || m.includes('app id'))
    return 'Неверный Access ID или выбран не тот регион';
  if (m.includes('not exist') || m.includes('not exists') || code === 2301)
    return 'Устройство не найдено — проверьте ID устройства и что оно привязано к облачному проекту';
  if (m.includes('permission') || m.includes('authority') || code === 28841002)
    return 'Нет доступа к API — добавьте сервис «IoT Core» в проекте Tuya Cloud и подождите пару минут';
  if (m.includes('token')) return 'Проблема с токеном Tuya — проверьте ключи и регион';
  return `Tuya: ${msg || 'неизвестная ошибка API'}`;
}

async function apiGet<T>(creds: TuyaCredentials, pathWithQuery: string): Promise<T> {
  const host = REGION_HOSTS[creds.region];
  const cacheKey = `${creds.region}:${creds.clientId}`;

  const attempt = async (token: string): Promise<TuyaResponse<T> | null> => {
    const t = Date.now().toString();
    // method \n path \n headers(пусто) \n body(пусто)
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
    return (await res.json().catch(() => null)) as TuyaResponse<T> | null;
  };

  let token = await fetchToken(creds);
  let json = await attempt(token);
  // 1010/1011 — токен недействителен: сбрасываем кэш и пробуем ещё раз
  if (json && !json.success && (json.code === 1010 || json.code === 1011)) {
    tokenCache.delete(cacheKey);
    token = await fetchToken(creds);
    json = await attempt(token);
  }
  if (!json) throw new TuyaError('Tuya Cloud недоступен — нет ответа от сервера');
  if (!json.success) throw new TuyaError(translateError(json.msg, json.code), json.code);
  return json.result as T;
}

/* ------------------------------ данные устройства ------------------------------ */

export async function getDeviceInfo(creds: TuyaCredentials): Promise<DeviceInfo> {
  const detail = await apiGet<Record<string, unknown>>(creds, `/v1.0/devices/${creds.deviceId}`);

  let status: TuyaStatusItem[] | null = Array.isArray(detail?.status)
    ? (detail.status as TuyaStatusItem[])
    : null;
  if (!status) {
    const st = await apiGet<TuyaStatusItem[] | { list?: TuyaStatusItem[] }>(
      creds,
      `/v1.0/devices/${creds.deviceId}/status`,
    );
    status = Array.isArray(st) ? st : (st?.list ?? []);
  }

  return {
    id: (detail?.id as string) ?? creds.deviceId,
    name: (detail?.name as string) ?? null,
    model: (detail?.model as string) ?? null,
    online: Boolean(detail?.online),
    status,
  };
}

/* ------------------------------ преобразование значений ------------------------------ */

/**
 * Температура: стандартный масштаб Tuya — десятые доли °C (235 → 23.5).
 * Редкие устройства шлют сотые доли (2350 → 23.5) — эвристика по величине.
 */
function convertTemperature(raw: number): number {
  let t = raw / 10;
  if (Math.abs(t) > 60) t = raw / 100;
  return Math.round(t * 10) / 10;
}

/** Влажность: чаще десятые доли (456 → 45.6), иногда целые проценты (45 → 45) */
function convertHumidity(raw: number): number {
  if (raw >= 1000) return Math.round((raw / 100) * 10) / 10;
  if (raw >= 100) return Math.round((raw / 10) * 10) / 10;
  return raw;
}

export function extractReading(status: TuyaStatusItem[]): SensorReading {
  let temperature: number | null = null;
  let humidity: number | null = null;
  let battery: number | null = null;

  for (const item of status) {
    const v = typeof item.value === 'string' ? Number(item.value) : item.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (temperature === null && TEMP_CODES.has(item.code)) {
      temperature = convertTemperature(v);
    } else if (humidity === null && HUM_CODES.has(item.code)) {
      humidity = convertHumidity(v);
    } else if (battery === null && BATT_CODES.has(item.code)) {
      battery = Math.max(0, Math.min(100, Math.round(v)));
    }
  }
  return { temperature, humidity, battery };
}

/* ------------------------------ история из журнала Tuya ------------------------------ */

/**
 * Тянет журнал отчётов DP (event_type = 7) за последние N часов
 * и собирает точки { время, температура, влажность, батарея } с шагом в минуту.
 */
export async function fetchDeviceHistory(
  creds: TuyaCredentials,
  hours = 24,
): Promise<HistoryPoint[]> {
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const params = new URLSearchParams({
    start_time: String(start),
    end_time: String(end),
    type: '7',
    size: '100',
  });
  const buckets = new Map<
    number,
    { temperature: number | null; humidity: number | null; battery: number | null }
  >();

  for (let page = 0; page < 30; page += 1) {
    const result = await apiGet<{
      logs?: Array<Record<string, unknown>>;
      has_more?: boolean;
      last_row_key?: string;
    }>(creds, `/v1.0/iot-03/devices/${creds.deviceId}/logs?${params.toString()}`);

    for (const log of result?.logs ?? []) {
      const code = typeof log.code === 'string' ? log.code : null;
      if (!code) continue;
      const raw = Number(log.value);
      if (!Number.isFinite(raw)) continue;
      let ts = Number(log.time ?? log.event_time ?? 0);
      if (!ts) continue;
      if (ts < 1e12) ts *= 1000; // секунды → миллисекунды
      const bucket = Math.floor(ts / 60_000) * 60_000;
      const entry = buckets.get(bucket) ?? { temperature: null, humidity: null, battery: null };
      if (TEMP_CODES.has(code)) entry.temperature = convertTemperature(raw);
      else if (HUM_CODES.has(code)) entry.humidity = convertHumidity(raw);
      else if (BATT_CODES.has(code)) entry.battery = Math.max(0, Math.min(100, Math.round(raw)));
      buckets.set(bucket, entry);
    }

    if (!result?.has_more || !result?.last_row_key) break;
    params.set('last_row_key', String(result.last_row_key));
  }

  return Array.from(buckets.entries())
    .map(([ms, v]) => ({ recordedAt: new Date(ms), ...v }))
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
}
