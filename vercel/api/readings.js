/**
 * Serverless-функция Vercel: живой опрос Tuya Cloud.
 *
 * GET /api/readings        — показания всех датчиков + история за 24 часа из журнала
 * GET /api/readings?mock=1 — тестовые данные без устройства (для проверки деплоя)
 *
 * Переменные окружения проекта Vercel:
 *   TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, TUYA_REGION (us|eu|euw|cn|in)
 *   TUYA_DEVICE_ID — список ID через запятую («id1,id2»)
 *                    или один ID: тогда функция пробует автообнаружить все
 *                    устройства с климатом или энергомониторингом
 *                    (Smart Home Management API) и при неудаче
 *                    возвращается к указанному устройству.
 *
 * Поддерживаются два типа устройств: датчики климата (температура,
 * влажность, батарея) и розетки с энергомониторингом (мощность,
 * напряжение, ток, накопленная энергия). Тип определяется по DP-кодам.
 *
 * Формат ответа совпадает с data/latest.json из GitHub Pages-версии
 * (топ-уровень + sensors[]), поэтому дашборд работает без изменений.
 * База данных не нужна: история тянется напрямую из журнала Tuya Cloud.
 *
 * Без зависимостей, Node.js 18+ (глобальный fetch).
 */

const { createHmac, createHash } = require('node:crypto');

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

const CLIMATE_CODES = new Set([...TEMP_CODES, ...HUM_CODES]); // признак датчика климата

/* Коды розеток с энергомониторингом. Признак розетки — хотя бы один код
   мощности/напряжения/тока/энергии (у лампочек и простых реле их нет). */
const POWER_CODES = new Set(['cur_power', 'power', 'power_b', 'power_w']);
const VOLTAGE_CODES = new Set(['cur_voltage', 'voltage', 'voltage_b']);
const CURRENT_CODES = new Set(['cur_current', 'current']);
const ENERGY_TOTAL_CODES = new Set(['add_ele', 'add_ele1', 'add_ele2', 'total_energy']);
const ENERGY_DAY_CODES = new Set(['day_ele', 'day_energy']);
const SWITCH_CODES = new Set(['switch_1', 'switch', 'switch_usb1', 'switch_usb']);
const PLUG_CODES = new Set([
  ...POWER_CODES,
  ...VOLTAGE_CODES,
  ...CURRENT_CODES,
  ...ENERGY_TOTAL_CODES,
  ...ENERGY_DAY_CODES,
]);

/* Запас до лимита serverless-функции (10 c на Hobby): собранные данные
   важнее полноты графика, поэтому при нехватке времени история укорачивается. */
const OVERALL_DEADLINE_MS = 6500;

/* Бюджет страниц журнала на один датчик, чтобы уложиться в общий дедлайн */
function pagesBudget(sensorCount) {
  return Math.max(3, Math.min(15, Math.floor(28 / Math.max(1, sensorCount))));
}

/* ------------------------------ подпись запросов ------------------------------ */

// SHA-256 пустого тела запроса — участвует в строке подписи (эмпирически проверено:
// сервер принимает ТОЛЬКО полную строку подписи, короткая «client_id + t» даёт 1004)
const EMPTY_BODY_SHA = createHash('sha256').update('').digest('hex');

function hmacSha256HexUpper(data, secret) {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex').toUpperCase();
}

/* Понятная расшифровка типовых ошибок авторизации Tuya Cloud */
function tuyaApiError(json, fallback) {
  const msg = json?.msg || fallback;
  const code = json?.code ? ` (код ${json.code})` : '';
  const m = String(msg || '').toLowerCase();
  let hint = '';
  if (m.includes('sign invalid')) {
    hint = '— Access ID найден, но Access Secret не совпадает: заново скопируйте Access Secret на вкладке Overview проекта (iot.tuya.com), убедитесь, что его не сбрасывали кнопкой Reset, в секрете нет кавычек и лишних символов, а регион TUYA_REGION совпадает с дата-центром проекта';
  } else if (m.includes('clientid')) {
    hint = '— проверьте Access ID проекта и регион TUYA_REGION (дата-центр должен совпадать с тем, что выбран в Overview)';
  } else if (json?.code === 28841002 || m.includes('subscription') || m.includes('permission')) {
    hint = '— подписка IoT Core у проекта истекла: в iot.tuya.com откройте Cloud → Cloud Services → IoT Core → Renew trial (заявку одобряют 1–2 рабочих дня), либо создайте новый проект с новым Trial';
  } else if (m.includes('time') || m.includes('expire')) {
    hint = '— расхождение времени с сервером Tuya, повторите позже';
  }
  return `Tuya: ${msg || 'неизвестная ошибка API'}${code}${hint ? ` ${hint}` : ''}`;
}

async function fetchToken(creds) {
  const host = REGION_HOSTS[creds.region];
  const tokenPath = '/v1.0/token?grant_type=1';
  const t = Date.now().toString();
  const stringToSign = ['GET', EMPTY_BODY_SHA, '', tokenPath].join('\n');
  const sign = hmacSha256HexUpper(creds.clientId + t + stringToSign, creds.clientSecret);
  const res = await fetch(`${host}${tokenPath}`, {
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
    throw new Error(json?.msg ? tuyaApiError(json, 'Не удалось получить токен Tuya Cloud') : 'Не удалось получить токен Tuya Cloud');
  }
  return json.result.access_token;
}

/* Tuya требует, чтобы query-параметры в строке подписи были отсортированы
   по ключам (официальный пример подписи сортирует query перед расчётом).
   Запросы с несколькими параметрами — например, журнал устройства /logs —
   без сортировки возвращают 1004 «sign invalid», хотя токен и статус работают.
   Значения остаются URL-кодированными: сервер сверяет подпись с тем же URL,
   что и в самом запросе. */
function canonicalTuyaUrl(pathWithQuery) {
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

async function apiGet(creds, token, pathWithQuery) {
  const host = REGION_HOSTS[creds.region];
  const url = canonicalTuyaUrl(pathWithQuery);
  const t = Date.now().toString();
  // GET \n sha256(пустое тело) \n \n path?отсортированный-query — именно в таком порядке требует сервер
  const stringToSign = ['GET', EMPTY_BODY_SHA, '', url].join('\n');
  const sign = hmacSha256HexUpper(creds.clientId + token + t + stringToSign, creds.clientSecret);
  const res = await fetch(`${host}${url}`, {
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
  if (!json.success) throw new Error(tuyaApiError(json, 'неизвестная ошибка API'));
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

/* Розетки: стандартные множители Tuya (спецификация DP-кодов):
   cur_power 0,1 Вт; cur_voltage 0,1 В; cur_current мА; add_ele 0,01 кВт·ч.
   Если значение выходит за физически правдоподобные пределы — подстраиваем
   множитель (некоторые производители используют другие разряды). */

// 16 А × 230 В ≈ 3,7 кВт — потолок бытовой розетки
function convertPower(raw) {
  let p = raw / 10;
  while (p > 4200) p /= 10;
  return Math.round(p * 10) / 10;
}

function plausibleVoltage(v) {
  return v >= 50 && v <= 260;
}

function convertVoltage(raw) {
  for (const scale of [10, 1, 100]) {
    const v = raw / scale;
    if (plausibleVoltage(v)) return Math.round(v * 10) / 10;
  }
  return Math.round((raw / 10) * 10) / 10;
}

function convertCurrent(raw) {
  let i = raw / 1000; // стандарт — миллиамперы
  while (i > 25) i /= 10; // больше 25 А в бытовую розетку не влезает
  return Math.round(i * 100) / 100;
}

function convertEnergy(raw) {
  return Math.round((raw / 100) * 100) / 100; // 0,01 кВт·ч
}

function parseSwitchValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function extractReading(status) {
  let temperature = null;
  let humidity = null;
  let battery = null;
  let on = null;
  let power = null;
  let voltage = null;
  let current = null;
  let energyTotal = null;
  let energyToday = null;
  for (const item of status ?? []) {
    // состояние реле: значение бывает булевым или строкой «true/false»
    if (on === null && SWITCH_CODES.has(item.code)) {
      on = parseSwitchValue(item.value);
      continue;
    }
    const v = typeof item.value === 'string' ? Number(item.value) : item.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (temperature === null && TEMP_CODES.has(item.code)) temperature = convertTemperature(v);
    else if (humidity === null && HUM_CODES.has(item.code)) humidity = convertHumidity(v);
    else if (battery === null && BATT_CODES.has(item.code)) battery = Math.max(0, Math.min(100, Math.round(v)));
    else if (power === null && POWER_CODES.has(item.code)) power = convertPower(v);
    else if (voltage === null && VOLTAGE_CODES.has(item.code)) voltage = convertVoltage(v);
    else if (current === null && CURRENT_CODES.has(item.code)) current = convertCurrent(v);
    else if (energyTotal === null && ENERGY_TOTAL_CODES.has(item.code)) energyTotal = convertEnergy(v);
    else if (energyToday === null && ENERGY_DAY_CODES.has(item.code)) energyToday = convertEnergy(v);
  }
  return { temperature, humidity, battery, on, power, voltage, current, energyTotal, energyToday };
}

/* Тип устройства по DP-кодам статуса: «plug», «climate» или «unknown» */
function detectType(status) {
  const codes = new Set((status ?? []).map((item) => item.code));
  const has = (set) => [...set].some((c) => codes.has(c));
  if (has(PLUG_CODES)) return 'plug';
  if (has(CLIMATE_CODES)) return 'climate';
  return 'unknown';
}

/* ------------------------------ история из журнала ------------------------------ */

async function fetchHistory(creds, token, deviceId, maxPages, deadline, hours = 24) {
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const base = { start_time: String(start), end_time: String(end), size: '100' };

  /* Один проход по журналу: до maxPages страниц по 100 записей, в пределах дедлайна. */
  const runPass = async (withType) => {
    const params = new URLSearchParams(withType ? { ...base, type: '7' } : base);
    const buckets = new Map();

    for (let page = 0; page < maxPages; page += 1) {
      if (Date.now() > deadline) {
        console.warn('Достигнут дедлайн времени — история может быть неполной');
        break;
      }
      const result = await apiGet(creds, token, `/v1.0/iot-03/devices/${deviceId}/logs?${params}`);
      for (const log of result?.logs ?? []) {
        const code = typeof log.code === 'string' ? log.code : null;
        if (!code) continue;
        const raw = Number(log.value);
        if (!Number.isFinite(raw)) continue;
        let ts = Number(log.time ?? log.event_time ?? 0);
        if (!ts) continue;
        if (ts < 1e12) ts *= 1000;
        const bucket = Math.floor(ts / 60_000) * 60_000;
        const entry = buckets.get(bucket) ?? { temperature: null, humidity: null, power: null, energy: null };
        if (TEMP_CODES.has(code)) entry.temperature = convertTemperature(raw);
        else if (HUM_CODES.has(code)) entry.humidity = convertHumidity(raw);
        else if (POWER_CODES.has(code)) entry.power = convertPower(raw);
        else if (ENERGY_TOTAL_CODES.has(code)) entry.energy = convertEnergy(raw);
        buckets.set(bucket, entry);
      }
      if (!result?.has_more || !result?.last_row_key) break;
      params.set('last_row_key', String(result.last_row_key));
    }
    return buckets;
  };

  /* Проход 1 — type=7 (отчёты точек данных). Если журнал пуст (часть проектов
     отдаёт записи только без фильтра типа) — проход 2 без фильтра: события
     вкл/выкл и прочие не-числовые записи парсер отсеет сам по DP-кодам. */
  let buckets = await runPass(true);
  if (buckets.size === 0) {
    console.warn(`Журнал type=7 пуст для «${deviceId}» — повторяю без фильтра типа`);
    buckets = await runPass(false);
  }

  return Array.from(buckets.entries())
    .map(([ms, v]) => ({
      t: new Date(ms).toISOString(),
      temp: v.temperature,
      hum: v.humidity,
      power: v.power,
      energy: v.energy,
    }))
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
  const powers = history.map((h) => h.power).filter((v) => v !== null);
  const agg = (arr, digits = 1) =>
    arr.length
      ? {
          min: Math.round(Math.min(...arr) * 10 ** digits) / 10 ** digits,
          avg: Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10 ** digits) / 10 ** digits,
          max: Math.round(Math.max(...arr) * 10 ** digits) / 10 ** digits,
        }
      : null;
  /* прирост счётчика за окно истории (≈24 ч): последний минус первый */
  const energies = history.map((h) => h.energy).filter((v) => v !== null);
  let energyDelta = null;
  if (energies.length >= 2) {
    const d = energies[energies.length - 1] - energies[0];
    if (d >= 0) energyDelta = Math.round(d * 100) / 100;
  }
  return { temp: agg(temps), hum: agg(hums), power: agg(powers), energyDelta };
}

/* ------------------------------ mock-режим ------------------------------ */

function mockSensor(name, id, baseTemp, baseHum, phaseShift) {
  const now = Date.now();
  const history = [];
  for (let i = 96; i >= 0; i -= 1) {
    const t = now - i * 15 * 60 * 1000;
    const phase = (i / 96) * Math.PI * 2;
    history.push({
      t: new Date(t).toISOString(),
      temp: Math.round((baseTemp + Math.sin(phase - 1.2 + phaseShift) * 1.6 + (Math.random() - 0.5) * 0.3) * 10) / 10,
      hum: Math.round((baseHum + Math.sin(phase + 0.8 + phaseShift) * 6 + (Math.random() - 0.5) * 1.5) * 10) / 10,
    });
  }
  const last = history[history.length - 1];
  return {
    id,
    status: 'ok',
    error: null,
    device: { name, model: 'TS0201', online: true },
    current: { temperature: last.temp, humidity: last.hum, battery: 87, recordedAt: last.t },
    stats: buildStats(history),
    history: downsample(history, 400),
  };
}

function buildMockData() {
  return {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    error: null,
    mock: true,
    sensors: [
      mockSensor('Гостиная', 'mock-livingroom', 22.4, 46, 0),
      mockSensor('Спальня', 'mock-bedroom', 19.8, 55, 1.1),
      mockSensor('Балкон', 'mock-balcony', 12.6, 71, 2.3),
      mockPlug('Розетка · обогреватель', 'mock-plug', 1150, 0.7),
    ],
  };
}

function mockPlug(name, id, basePower, phaseShift) {
  const now = Date.now();
  const stepMs = 15 * 60 * 1000;
  const kWhPerWms = 1 / 3_600_000_000; // Вт × мс → кВт·ч
  const history = [];
  let energy = 1243.82; // накопленный счётчик, кВт·ч
  for (let i = 96; i >= 0; i -= 1) {
    const t = now - i * stepMs;
    // обогреватель: периодические циклы вкл/выкл
    const isOn = Math.sin((i / 96) * Math.PI * 6 + phaseShift) > -0.2;
    const power = isOn ? Math.round((basePower + (Math.random() - 0.5) * 60) * 10) / 10 : 0;
    if (i < 96) energy += history[history.length - 1].power * stepMs * kWhPerWms;
    history.push({
      t: new Date(t).toISOString(),
      temp: null,
      hum: null,
      power,
      energy: Math.round(energy * 100) / 100,
    });
  }
  const last = history[history.length - 1];
  return {
    id,
    status: 'ok',
    error: null,
    type: 'plug',
    device: { name, model: 'TS011F', online: true },
    current: {
      temperature: null,
      humidity: null,
      battery: null,
      on: last.power > 0,
      power: last.power,
      voltage: 227.8,
      current: Math.round((last.power / 227.8) * 100) / 100,
      energyTotal: last.energy,
      energyToday: null,
      recordedAt: last.t,
    },
    stats: buildStats(history),
    history: downsample(history, 400),
  };
}

/* ------------------------------ список датчиков ------------------------------ */

function parseDeviceList(raw) {
  const list = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

/**
 * Автообнаружение: uid из карточки устройства-якоря → все устройства аккаунта
 * (Smart Home Management API) → остаются только датчики климата.
 * Возвращает массив карточек устройств либо null, если API недоступен.
 */
async function discoverSensors(creds, token, anchorId) {
  try {
    const anchor = await apiGet(creds, token, `/v1.0/devices/${anchorId}`);
    const uid = anchor?.uid;
    if (!uid) {
      console.warn('Автообнаружение недоступно: у устройства нет uid — беру явный список');
      return null;
    }
    const devices = await apiGet(creds, token, `/v1.0/users/${uid}/devices`);
    if (!Array.isArray(devices)) {
      console.warn('Автообнаружение недоступно: неожиданный ответ API — беру явный список');
      return null;
    }
    const sensors = devices.filter(
      (d) =>
        Array.isArray(d?.status) &&
        d.status.some((item) => CLIMATE_CODES.has(item.code) || PLUG_CODES.has(item.code)),
    );
    // якорь должен попасть в список, даже если фильтр его пропустил
    if (!sensors.some((d) => d?.id === anchorId) && anchor?.id) sensors.push(anchor);
    console.log(`Автообнаружение: устройств с климатом/энергией — ${sensors.length}`);
    return sensors;
  } catch (err) {
    console.warn(`Автообнаружение не удалось (${err.message}) — беру явный список`);
    return null;
  }
}

/* ------------------------------ сбор реальных данных ------------------------------ */

function readCreds() {
  const clientId = (process.env.TUYA_CLIENT_ID || '').trim();
  const clientSecret = (process.env.TUYA_CLIENT_SECRET || '').trim();
  const region = (process.env.TUYA_REGION || 'eu').trim();
  const ids = parseDeviceList(process.env.TUYA_DEVICE_ID);

  const missing = [
    !clientId && 'TUYA_CLIENT_ID',
    !clientSecret && 'TUYA_CLIENT_SECRET',
    ids.length === 0 && 'TUYA_DEVICE_ID',
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
  return { clientId, clientSecret, region, ids };
}

async function collectReal() {
  const creds = readCreds();
  const deadline = Date.now() + OVERALL_DEADLINE_MS;
  const token = await fetchToken(creds);
  const now = new Date();

  // определяем список датчиков: один id — автообнаружение, несколько — явный список
  let details = null;
  if (creds.ids.length === 1) {
    details = await discoverSensors(creds, token, creds.ids[0]);
  }
  if (!details) {
    details = [];
    for (const id of creds.ids) {
      try {
        details.push(await apiGet(creds, token, `/v1.0/devices/${id}`));
      } catch (err) {
        details.push({ id, name: null, model: null, online: false, status: [], __error: err.message });
      }
    }
  }

  const maxPages = pagesBudget(details.length);

  // собираем секции последовательно, ошибки одного датчика не мешают остальным
  const sensors = [];
  const errors = [];
  for (const detail of details) {
    if (detail?.__error) {
      errors.push(`${detail.name ?? detail.id}: ${detail.__error}`);
      sensors.push({
        id: detail.id,
        status: 'error',
        error: detail.__error,
        device: { name: detail.name ?? null, model: null, online: false },
        current: null,
        stats: null,
        history: [],
      });
      continue;
    }
    const section = {
      id: detail?.id ?? null,
      status: 'ok',
      error: null,
      type: detectType(detail?.status),
      device: {
        name: detail?.name ?? null,
        model: detail?.model ?? null,
        online: Boolean(detail?.online),
      },
      current: { ...extractReading(detail?.status), recordedAt: now.toISOString() },
      stats: null,
      history: [],
    };
    try {
      section.history = await fetchHistory(creds, token, detail.id, maxPages, deadline, 24);
    } catch (err) {
      console.warn(`Журнал «${detail?.name ?? detail?.id}» недоступен (${err.message}) — график будет пустым`);
    }
    section.stats = buildStats(section.history);
    section.history = downsample(section.history, 400);
    sensors.push(section);
  }

  const okCount = sensors.filter((s) => s.status === 'ok').length;
  return {
    status: okCount === 0 ? 'error' : okCount === sensors.length ? 'ok' : 'partial',
    generatedAt: now.toISOString(),
    error: okCount === 0 ? errors[0] ?? 'Не удалось получить данные ни от одного датчика' : null,
    mock: false,
    sensors,
  };
}

function errorPayload(message) {
  return {
    status: 'error',
    generatedAt: new Date().toISOString(),
    error: message,
    mock: false,
    sensors: [],
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

/* Внутренние функции открыты для тестов (test-plug-conversions.mjs) */
Object.assign(module.exports, {
  extractReading,
  detectType,
  convertPower,
  convertVoltage,
  convertCurrent,
  convertEnergy,
  buildStats,
});
