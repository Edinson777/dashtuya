# Монитор климата — датчик Tuya

Тёмный веб-дашборд для отображения показаний датчика температуры и влажности из [Tuya IoT Cloud](https://iot.tuya.com): крупные карточки значений, график за 24 часа, заряд батареи и статус устройства.

![stack](https://img.shields.io/badge/Next.js%2016-React%2019-black) ![db](https://img.shields.io/badge/Prisma-SQLite-blue) ![ui](https://img.shields.io/badge/Tailwind%204-shadcn%2Fui-06b6d4)

## Возможности

- **Текущие показания** — температура (°C) с трендом, влажность (%) с индикатором «Комфортно / Сухо / Влажно», заряд батареи
- **График за 24 часа** — две кривые (температура и влажность) с зоной комфорта 30–60%; история тянется из журнала Tuya Cloud и сохраняется в локальную базу
- **Статус устройства** — онлайн/офлайн, модель, ID, время последней синхронизации
- **Настройка прямо на странице** — Access ID / Access Secret / ID устройства / регион дата-центра (5 дата-центров Tuya), с проверкой подключения
- **Ручное обновление** — кнопка «Обновить» запрашивает свежие показания и дотягивает журнал отчётов за сутки
- **Безопасность** — ключи хранятся только в локальной SQLite-базе, на клиент возвращаются в маскированном виде; база исключена из git

## Стек

| Слой | Технология |
| --- | --- |
| Фреймворк | Next.js 16 (App Router), TypeScript |
| UI | Tailwind CSS 4, shadcn/ui, recharts, framer-motion, lucide-react |
| Данные | Prisma ORM + SQLite |
| Интеграция | Tuya IoT OpenAPI (HMAC-SHA256-подпись запросов, токены, журнал устройства) |

## Быстрый старт

Требуется [Bun](https://bun.sh) (или Node.js 20+ с пакетным менеджером на выбор).

```bash
# 1. зависимости
bun install

# 2. переменные окружения
echo 'DATABASE_URL="file:'$PWD'/db/custom.db"' > .env

# 3. схема базы
bun run db:push

# 4. запуск dev-сервера
bun run dev
```

Откройте `http://localhost:3000`, на странице введите ключи Tuya Cloud и ID устройства, нажмите «Сохранить и подключиться».

## Как получить ключи Tuya

1. Зарегистрируйтесь на [iot.tuya.com](https://iot.tuya.com) → **Cloud → Cloud Development → Create Cloud Project** (подойдёт Trial-подписка).
2. **Access ID** и **Access Secret** — на вкладке *Overview* проекта.
3. Подпишитесь на API-сервис **IoT Core** (статус и журнал устройства); при желании — *Smart Home Management*.
4. Привяжите датчик: **Devices → Link Tuya App Device** — отсканируйте QR-код из приложения Tuya Smart / Smart Life.
5. **ID устройства** — в списке *Devices* облака или в приложении: устройство → карандаш → *Device ID*.
6. На странице дашборда выберите регион дата-центра, соответствующий вашему аккаунту:
   - Америки — `openapi.tuya.com`
   - Центральная Европа — `openapi.tuyaeu.com`
   - Западная Европа — `openapi.tuyaus.com`
   - Китай — `openapi.tuya.cn`
   - Индия — `openapi.tuyain.com`

## Варианты размещения

### Локально / на своём сервере (полная функциональность)

Как описано в «Быстром старте»: живой опрос Tuya, кнопка «Обновить», настройки на странице, история в SQLite.

### GitHub Pages (без сервера, витрина показаний)

Статичная версия дашборда из папки [`site/`](site/) публикуется на GitHub Pages, а данные собирает GitHub Actions по расписанию (каждые ~20 минут) — воркфлоу [`.github/workflows/pages.yml`](.github/workflows/pages.yml) опрашивает Tuya Cloud и публикует `data/latest.json` вместе с сайтом.

Одна настройка в репозитории:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. **Settings → Secrets and variables → Actions** — добавьте секреты:
   - `TUYA_CLIENT_ID` — Access ID проекта
   - `TUYA_CLIENT_SECRET` — Access Secret проекта
   - `TUYA_DEVICE_ID` — ID датчика
3. На вкладке **Variables** того же раздела — переменную `TUYA_REGION` со значением `us`, `eu`, `euw`, `cn` или `in`.

После этого запуск воркфлоу вручную (Actions → воркфлоу → Run workflow) или по расписанию обновит страницу: `https://<ваш-логин>.github.io/<репозиторий>/`.

Ключи хранятся только в зашифрованных Secrets и не попадают ни в код, ни в логи сборки. Для проверки вёрстки без устройства скрипт поддерживает тестовые данные: `node scripts/collect-pages-data.mjs --mock`.

## Структура проекта

```
src/
├── app/
│   ├── page.tsx                  # дашборд: карточки, график, настройки
│   └── api/tuya/
│       ├── state/route.ts        # GET  — состояние из локальной базы
│       ├── settings/route.ts     # POST — сохранить ключи / забыть устройство
│       └── refresh/route.ts      # POST — опрос Tuya Cloud, запись показаний
├── lib/
│   ├── tuya.ts                   # клиент Tuya OpenAPI: подпись HMAC-SHA256, токен, статус, журнал
│   ├── tuyaStore.ts              # запись истории с дедупликацией, очистка старше 7 дней
│   └── state.ts                  # сборка состояния страницы, маскирование секретов
└── components/ui/                # shadcn/ui компоненты

site/                             # статичная версия для GitHub Pages (HTML/CSS/JS + Chart.js)
scripts/collect-pages-data.mjs    # сборщик данных для Actions: Tuya → data/latest.json
scripts/seed-test.mjs             # тестовые данные для локальной проверки без устройства
.github/workflows/pages.yml       # воркфлоу: сбор по расписанию + деплой на Pages

prisma/schema.prisma              # модели Settings (ключи) и Reading (показания)
```

## Распознаваемые коды датчиков

| Параметр | DP-коды |
| --- | --- |
| Температура | `va_temperature`, `temp_current`, `temperature`, `current_temperature`, `temp_indoor` |
| Влажность | `va_humidity`, `humidity_current`, `humidity`, `current_humidity`, `humidity_value` |
| Батарея | `battery_percentage`, `battery`, `battery_value`, `va_battery` |

Значения температуры приводятся из десятых долей °C (235 → 23.5°), с эвристикой для устройств со стоградусным масштабом; влажность — из десятых долей процента или целых процентов.

## Безопасность

- `.gitignore` исключает `db/` (SQLite с ключами), `.env` и личные файлы — секреты не попадают в репозиторий
- Access Secret никогда не возвращается на клиент в открытом виде (маскируется на сервере)
- Токены доступа Tuya кэшируются в памяти процесса и обновляются автоматически

## Лицензия

MIT
