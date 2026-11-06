'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BatteryCharging,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Droplets,
  Info,
  KeyRound,
  Minus,
  RefreshCw,
  Thermometer,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { motion } from 'framer-motion';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';

/* ------------------------------- типы и константы ------------------------------- */

interface HistoryDto {
  recordedAt: string;
  temperature: number | null;
  humidity: number | null;
  battery: number | null;
}

interface PageState {
  configured: boolean;
  current: {
    temperature: number | null;
    humidity: number | null;
    battery: number | null;
    recordedAt: string;
  } | null;
  history: HistoryDto[];
  device: {
    id: string;
    name: string | null;
    model: string | null;
    online: boolean | null;
    region: string | null;
    regionLabel: string | null;
  } | null;
  lastSyncAt: string | null;
  clientIdMasked: string | null;
  secretSet: boolean;
}

const REGIONS: Array<{ value: string; label: string }> = [
  { value: 'us', label: 'Америки — openapi.tuya.com' },
  { value: 'eu', label: 'Центральная Европа — openapi.tuyaeu.com' },
  { value: 'euw', label: 'Западная Европа — openapi.tuyaus.com' },
  { value: 'cn', label: 'Китай — openapi.tuya.cn' },
  { value: 'in', label: 'Индия — openapi.tuyain.com' },
];

const COLORS = {
  temp: '#fbbf24',
  hum: '#22d3ee',
  grid: 'rgba(148, 163, 184, 0.1)',
  tick: '#64748b',
};

/* ------------------------------- утилиты ------------------------------- */

function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  const diff = now - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '—';
  if (diff < 15_000) return 'только что';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} с назад`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`;
  return `${Math.floor(diff / 86_400_000)} дн назад`;
}

function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('ru-RU', { maximumFractionDigits: digits });
}

function humidityComfort(h: number | null): { label: string; className: string } | null {
  if (h === null || !Number.isFinite(h)) return null;
  if (h < 30) return { label: 'Сухо', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
  if (h > 60) return { label: 'Влажно', className: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' };
  return { label: 'Комфортно', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
}

/* ------------------------------- страница ------------------------------- */

export default function Home() {
  const { toast } = useToast();

  const [state, setState] = useState<PageState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [form, setForm] = useState({
    clientId: '',
    clientSecret: '',
    deviceId: '',
    region: 'eu',
  });

  const applyState = useCallback(
    (next: PageState) => {
      setState(next);
      setForm((f) => ({
        ...f,
        deviceId: f.deviceId || next.device?.id || '',
        region: next.device?.region || f.region,
      }));
      if (!next.configured) setSettingsOpen(true);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/tuya/state');
        const json = (await res.json()) as PageState;
        if (!cancelled) applyState(json);
      } catch {
        if (!cancelled) {
          toast({
            title: 'Не удалось загрузить состояние',
            description: 'Проверьте соединение и обновите страницу',
            variant: 'destructive',
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyState, toast]);

  // тикер для «обновлено N назад» — только текст, данные не перезапрашиваются
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/tuya/refresh', { method: 'POST' });
      const json = (await res.json()) as { ok?: boolean; error?: string; state?: PageState };
      if (!res.ok || json.error || !json.state) {
        toast({ title: 'Ошибка обновления', description: json.error, variant: 'destructive' });
      } else {
        applyState(json.state);
        setNow(Date.now());
        toast({ title: 'Показания обновлены', description: 'Данные получены из Tuya Cloud' });
      }
    } catch {
      toast({
        title: 'Ошибка сети',
        description: 'Не удалось связаться с сервером приложения',
        variant: 'destructive',
      });
    } finally {
      setRefreshing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/tuya/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        warning?: string | null;
        error?: string;
        state?: PageState;
      };
      if (json.error || !json.state) {
        toast({ title: 'Настройки не сохранены', description: json.error, variant: 'destructive' });
        return;
      }
      applyState(json.state);
      if (json.warning) {
        toast({
          title: 'Ключи сохранены, но проверка не прошла',
          description: json.warning,
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Подключено',
          description: 'Устройство Tuya отвечает, показания получены',
        });
        setSettingsOpen(false);
      }
    } catch {
      toast({
        title: 'Ошибка сети',
        description: 'Не удалось сохранить настройки',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleForget = async () => {
    try {
      const res = await fetch('/api/tuya/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forget: true }),
      });
      const json = (await res.json()) as { ok?: boolean; state?: PageState };
      if (json.state) applyState(json.state);
      setForm({ clientId: '', clientSecret: '', deviceId: '', region: 'eu' });
      setSettingsOpen(true);
      toast({ title: 'Настройки сброшены', description: 'История и ключи удалены из локальной базы' });
    } catch {
      toast({ title: 'Ошибка сети', description: 'Не удалось сбросить настройки', variant: 'destructive' });
    }
  };

  /* ------------------------------ производные данные ------------------------------ */

  const history = state?.history ?? [];

  const chartData = useMemo(
    () =>
      history.map((h) => ({
        t: new Date(h.recordedAt).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        temp: h.temperature,
        hum: h.humidity,
      })),
    [history],
  );

  const stats = useMemo(() => {
    const temps = history.map((h) => h.temperature).filter((v): v is number => v !== null);
    const hums = history.map((h) => h.humidity).filter((v): v is number => v !== null);
    const avg = (arr: number[]) =>
      arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
    return {
      tempMin: temps.length ? Math.min(...temps) : null,
      tempMax: temps.length ? Math.max(...temps) : null,
      tempAvg: avg(temps),
      humMin: hums.length ? Math.min(...hums) : null,
      humMax: hums.length ? Math.max(...hums) : null,
      humAvg: avg(hums),
    };
  }, [history]);

  const trend = useMemo(() => {
    const temps = history.map((h) => h.temperature).filter((v): v is number => v !== null);
    if (temps.length < 2) return null;
    const delta = temps[temps.length - 1] - temps[temps.length - 2];
    if (Math.abs(delta) < 0.05) return { delta: 0, dir: 'flat' as const };
    return { delta, dir: delta > 0 ? ('up' as const) : ('down' as const) };
  }, [history]);

  const current = state?.current ?? null;
  const device = state?.device ?? null;
  const comfort = humidityComfort(current?.humidity ?? null);
  const lastRecordIso = current?.recordedAt ?? state?.lastSyncAt ?? null;

  /* ------------------------------ рендер ------------------------------ */

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      {/* фоновая подсветка */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            'radial-gradient(1000px 500px at 15% -10%, rgba(34, 211, 238, 0.08), transparent 60%), radial-gradient(900px 500px at 110% 10%, rgba(251, 191, 36, 0.06), transparent 60%)',
        }}
      />

      {/* Шапка */}
      <header className="sticky top-0 z-20 border-b border-white/5 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10">
              <Thermometer className="h-5 w-5 text-cyan-400" aria-hidden />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Монитор климата</h1>
              <p className="text-xs text-slate-400">Датчик Tuya · температура и влажность</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {state?.configured && (
              <span className="hidden text-xs text-slate-400 sm:inline">
                Обновлено {timeAgo(lastRecordIso, now)}
              </span>
            )}
            <Button
              onClick={handleRefresh}
              disabled={loading || refreshing || !state?.configured}
              className="h-11 gap-2 bg-cyan-500 text-slate-950 hover:bg-cyan-400"
              aria-label="Обновить показания из Tuya Cloud"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
              {refreshing ? 'Обновляем…' : 'Обновить'}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 py-6">
        {loading ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Skeleton className="h-44 rounded-xl bg-slate-800/60" />
              <Skeleton className="h-44 rounded-xl bg-slate-800/60" />
              <Skeleton className="h-44 rounded-xl bg-slate-800/60" />
            </div>
            <Skeleton className="h-80 rounded-xl bg-slate-800/60" />
          </div>
        ) : !state?.configured ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            <Card className="border-white/10 bg-slate-900/70">
              <CardHeader>
                <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10">
                  <KeyRound className="h-6 w-6 text-amber-400" aria-hidden />
                </div>
                <CardTitle className="text-xl">Подключите датчик Tuya</CardTitle>
                <CardDescription className="text-slate-400">
                  Введите ключи Tuya Cloud API — страница сама запросит показания устройства и
                  историю за 24 часа. Ключи хранятся только в локальной базе этого приложения.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SettingsForm
                  form={form}
                  setForm={setForm}
                  onSave={handleSave}
                  saving={saving}
                  state={null}
                />
              </CardContent>
            </Card>
          </motion.div>
        ) : (
          <>
            {/* Карточки показателей */}
            <div className="grid gap-4 md:grid-cols-3">
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: 0 }}
              >
                <Card className="h-full border-white/10 bg-slate-900/70">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
                          <Thermometer className="h-4 w-4 text-amber-400" aria-hidden />
                        </span>
                        Температура
                      </CardTitle>
                      {trend && (
                        <span className="flex items-center gap-1 text-xs text-slate-400">
                          {trend.dir === 'up' ? (
                            <ArrowUpRight className="h-3.5 w-3.5 text-amber-400" aria-hidden />
                          ) : trend.dir === 'down' ? (
                            <ArrowDownRight className="h-3.5 w-3.5 text-cyan-400" aria-hidden />
                          ) : (
                            <Minus className="h-3.5 w-3.5 text-slate-500" aria-hidden />
                          )}
                          {trend.dir === 'flat' ? 'стабильно' : `${fmt(Math.abs(trend.delta))}°`}
                        </span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-1">
                      <span className="text-5xl font-semibold tracking-tight">
                        {current?.temperature !== null && current?.temperature !== undefined
                          ? fmt(current.temperature)
                          : '—'}
                      </span>
                      <span className="text-xl text-amber-400">°C</span>
                    </div>
                    <p className="mt-3 text-xs text-slate-400">
                      {stats.tempMin !== null
                        ? `за 24 ч: мин ${fmt(stats.tempMin)}° · ср. ${fmt(stats.tempAvg)}° · макс ${fmt(stats.tempMax)}°`
                        : 'История за сутки появится после синхронизации'}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: 0.06 }}
              >
                <Card className="h-full border-white/10 bg-slate-900/70">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10">
                          <Droplets className="h-4 w-4 text-cyan-400" aria-hidden />
                        </span>
                        Влажность
                      </CardTitle>
                      {comfort && (
                        <Badge variant="outline" className={`text-xs ${comfort.className}`}>
                          {comfort.label}
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-1">
                      <span className="text-5xl font-semibold tracking-tight">
                        {current?.humidity !== null && current?.humidity !== undefined
                          ? fmt(current.humidity, 0)
                          : '—'}
                      </span>
                      <span className="text-xl text-cyan-400">%</span>
                    </div>
                    <div className="relative mt-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        aria-hidden
                        className="absolute inset-y-0 left-[30%] w-[30%] bg-cyan-500/15"
                      />
                      {current?.humidity !== null && current?.humidity !== undefined && (
                        <div
                          aria-hidden
                          className="absolute inset-y-0 w-1 rounded bg-cyan-400"
                          style={{ left: `calc(${Math.min(100, Math.max(0, current.humidity))}% - 2px)` }}
                        />
                      )}
                    </div>
                    <div className="mt-1.5 flex justify-between text-[10px] text-slate-500">
                      <span>0%</span>
                      <span>зона 30–60%</span>
                      <span>100%</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">
                      {stats.humMin !== null
                        ? `за 24 ч: мин ${fmt(stats.humMin, 0)}% · ср. ${fmt(stats.humAvg, 0)}% · макс ${fmt(stats.humMax, 0)}%`
                        : ' '}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: 0.12 }}
              >
                <Card className="h-full border-white/10 bg-slate-900/70">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                        <Cpu className="h-4 w-4 text-emerald-400" aria-hidden />
                      </span>
                      Устройство
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {device?.name || 'Датчик Tuya'}
                      </span>
                      {device?.online === true ? (
                        <Badge
                          variant="outline"
                          className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300"
                        >
                          <Wifi className="h-3 w-3" aria-hidden />
                          Онлайн
                        </Badge>
                      ) : device?.online === false ? (
                        <Badge
                          variant="outline"
                          className="gap-1.5 border-rose-500/30 bg-rose-500/10 text-xs text-rose-300"
                        >
                          <WifiOff className="h-3 w-3" aria-hidden />
                          Офлайн
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-slate-400">
                          Статус неизвестен
                        </Badge>
                      )}
                    </div>
                    {device?.model && (
                      <p className="text-xs text-slate-400">Модель: {device.model}</p>
                    )}
                    {device && (
                      <p className="truncate font-mono text-[11px] text-slate-500" title={device.id}>
                        ID: {device.id}
                      </p>
                    )}
                    <div>
                      <div className="mb-1.5 flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 text-slate-300">
                          <BatteryCharging className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                          Батарея
                        </span>
                        <span className="text-slate-400">
                          {current?.battery !== null && current?.battery !== undefined
                            ? `${fmt(current.battery, 0)}%`
                            : 'не сообщается'}
                        </span>
                      </div>
                      {current?.battery !== null && current?.battery !== undefined ? (
                        <Progress
                          value={current.battery}
                          className="h-2 bg-slate-800 [&>div]:bg-emerald-400"
                          aria-label={`Заряд батареи ${current.battery}%`}
                        />
                      ) : (
                        <div className="h-2 rounded-full bg-slate-800" />
                      )}
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            </div>

            {/* График за 24 часа */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.18 }}
            >
              <Card className="border-white/10 bg-slate-900/70">
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">История за 24 часа</CardTitle>
                      <CardDescription className="text-slate-400">
                        Данные из журнала Tuya Cloud и локальных синхронизаций
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-300">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: COLORS.temp }} />
                        Температура, °C
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: COLORS.hum }} />
                        Влажность, %
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {chartData.length < 2 ? (
                    <div className="flex h-72 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-white/10 text-center">
                      <Info className="h-6 w-6 text-slate-500" aria-hidden />
                      <p className="max-w-sm text-sm text-slate-400">
                        Истории пока нет. Нажмите «Обновить» — страница подтянет журнал отчётов
                        датчика за 24 часа. Если график остался пустым, добавьте в проекте Tuya
                        Cloud разрешение на чтение журналов (сервис «IoT Core»).
                      </p>
                    </div>
                  ) : (
                    <div className="h-80 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="gradTemp" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={COLORS.temp} stopOpacity={0.25} />
                              <stop offset="100%" stopColor={COLORS.temp} stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="gradHum" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={COLORS.hum} stopOpacity={0.2} />
                              <stop offset="100%" stopColor={COLORS.hum} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke={COLORS.grid} vertical={false} />
                          <XAxis
                            dataKey="t"
                            tick={{ fill: COLORS.tick, fontSize: 12 }}
                            tickMargin={8}
                            minTickGap={48}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis
                            yAxisId="temp"
                            tick={{ fill: COLORS.tick, fontSize: 12 }}
                            tickFormatter={(v: number) => `${v}°`}
                            width={44}
                            axisLine={false}
                            tickLine={false}
                            domain={['auto', 'auto']}
                          />
                          <YAxis
                            yAxisId="hum"
                            orientation="right"
                            domain={[0, 100]}
                            tick={{ fill: COLORS.tick, fontSize: 12 }}
                            tickFormatter={(v: number) => `${v}%`}
                            width={44}
                            axisLine={false}
                            tickLine={false}
                          />
                          <ReferenceArea
                            yAxisId="hum"
                            y1={30}
                            y2={60}
                            fill={COLORS.hum}
                            fillOpacity={0.05}
                          />
                          <ReTooltip
                            cursor={{ stroke: 'rgba(148,163,184,0.3)', strokeDasharray: '4 4' }}
                            content={({ active, payload, label }) => {
                              if (!active || !payload?.length) return null;
                              const row = payload[0]?.payload as
                                | { temp?: number | null; hum?: number | null }
                                | undefined;
                              return (
                                <div className="rounded-lg border border-white/10 bg-slate-900/95 px-3 py-2 text-xs shadow-xl">
                                  <p className="mb-1 font-medium text-slate-300">{label}</p>
                                  <p className="flex items-center gap-2 text-slate-200">
                                    <span
                                      className="h-2 w-2 rounded-full"
                                      style={{ background: COLORS.temp }}
                                    />
                                    Температура: {row?.temp != null ? `${fmt(row.temp)} °C` : '—'}
                                  </p>
                                  <p className="flex items-center gap-2 text-slate-200">
                                    <span
                                      className="h-2 w-2 rounded-full"
                                      style={{ background: COLORS.hum }}
                                    />
                                    Влажность: {row?.hum != null ? `${fmt(row.hum)} %` : '—'}
                                  </p>
                                </div>
                              );
                            }}
                          />
                          <Area
                            yAxisId="temp"
                            type="monotone"
                            dataKey="temp"
                            stroke={COLORS.temp}
                            strokeWidth={2}
                            fill="url(#gradTemp)"
                            dot={false}
                            activeDot={{ r: 4, strokeWidth: 0 }}
                            connectNulls
                            name="Температура"
                          />
                          <Area
                            yAxisId="hum"
                            type="monotone"
                            dataKey="hum"
                            stroke={COLORS.hum}
                            strokeWidth={2}
                            fill="url(#gradHum)"
                            dot={false}
                            activeDot={{ r: 4, strokeWidth: 0 }}
                            connectNulls
                            name="Влажность"
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>

            {/* Настройки подключения */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.24 }}
            >
              <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
                <Card className="border-white/10 bg-slate-900/70">
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="flex h-14 w-full items-center justify-between px-6 text-left hover:bg-transparent"
                      aria-expanded={settingsOpen}
                    >
                      <span className="flex items-center gap-3">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-600/40 bg-slate-800/60">
                          <Activity className="h-4 w-4 text-slate-300" aria-hidden />
                        </span>
                        <span>
                          <span className="block text-sm font-medium">Настройки подключения</span>
                          <span className="block text-xs text-slate-400">
                            {state.clientIdMasked
                              ? `Access ID: ${state.clientIdMasked} · ${
                                  device?.regionLabel || 'регион не указан'
                                }`
                              : 'Tuya Cloud API: ключи и регион'}
                          </span>
                        </span>
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 text-slate-400 transition-transform ${settingsOpen ? 'rotate-180' : ''}`}
                        aria-hidden
                      />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="pt-0">
                      <SettingsForm
                        form={form}
                        setForm={setForm}
                        onSave={handleSave}
                        saving={saving}
                        state={state}
                        onForget={handleForget}
                      />
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            </motion.div>
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-white/5 bg-slate-950">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-slate-500">
          <span>
            Ключи Tuya хранятся локально в базе приложения и не отправляются третьим сторонам
          </span>
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
            Данные: Tuya Cloud API · обновление вручную
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------- форма настроек ------------------------------- */

interface SettingsFormProps {
  form: { clientId: string; clientSecret: string; deviceId: string; region: string };
  setForm: React.Dispatch<
    React.SetStateAction<{ clientId: string; clientSecret: string; deviceId: string; region: string }>
  >;
  onSave: () => void;
  saving: boolean;
  state: PageState | null;
  onForget?: () => void;
}

function SettingsForm({ form, setForm, onSave, saving, state, onForget }: SettingsFormProps) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="clientId">Access ID</Label>
          <Input
            id="clientId"
            autoComplete="off"
            placeholder="Access ID из проекта Tuya Cloud"
            value={form.clientId}
            onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
          />
          {state?.clientIdMasked && (
            <p className="text-xs text-slate-500">
              Сохранён: {state.clientIdMasked} — оставьте поле пустым, чтобы не менять
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="clientSecret">Access Secret</Label>
          <Input
            id="clientSecret"
            type="password"
            autoComplete="new-password"
            placeholder={state?.secretSet ? '•••••••• (сохранён)' : 'Access Secret проекта'}
            value={form.clientSecret}
            onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))}
          />
          {state?.secretSet && (
            <p className="text-xs text-slate-500">Оставьте пустым, чтобы использовать сохранённый</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="deviceId">ID устройства</Label>
          <Input
            id="deviceId"
            autoComplete="off"
            placeholder="Например, eb3d5a79f4c2b100xxxxxxxx"
            value={form.deviceId}
            onChange={(e) => setForm((f) => ({ ...f, deviceId: e.target.value }))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="region">Регион дата-центра</Label>
          <Select
            value={form.region}
            onValueChange={(v) => setForm((f) => ({ ...f, region: v }))}
          >
            <SelectTrigger id="region" className="w-full">
              <SelectValue placeholder="Выберите регион" />
            </SelectTrigger>
            <SelectContent>
              {REGIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={onSave}
          disabled={saving}
          className="h-11 min-w-52 gap-2 bg-cyan-500 text-slate-950 hover:bg-cyan-400"
        >
          <RefreshCw className={`h-4 w-4 ${saving ? 'animate-spin' : ''}`} aria-hidden />
          {saving ? 'Проверяем и сохраняем…' : 'Сохранить и подключиться'}
        </Button>
        {state && onForget && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                className="h-11 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
              >
                Забыть устройство
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="border-white/10 bg-slate-900 text-slate-100">
              <AlertDialogHeader>
                <AlertDialogTitle>Забыть устройство?</AlertDialogTitle>
                <AlertDialogDescription className="text-slate-400">
                  Настройки подключения и вся локальная история показаний будут удалены. Данные в
                  облаке Tuya останутся без изменений.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="border-white/10 bg-slate-800 text-slate-200 hover:bg-slate-700">
                  Отмена
                </AlertDialogCancel>
                <AlertDialogAction className="bg-rose-600 text-white hover:bg-rose-500" onClick={onForget}>
                  Забыть
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <div className="rounded-lg border border-white/10 bg-slate-800/40 p-4 text-xs leading-relaxed text-slate-400">
        <p className="mb-2 font-medium text-slate-300">Где взять ключи и ID устройства</p>
        <ol className="list-inside list-decimal space-y-1">
          <li>
            На{' '}
            <a
              href="https://iot.tuya.com"
              target="_blank"
              rel="noreferrer"
              className="text-cyan-400 underline-offset-2 hover:underline"
            >
              iot.tuya.com
            </a>{' '}
            откройте Cloud → Cloud Development и создайте проект (подойдёт Trial-подписка).
          </li>
          <li>Access ID и Access Secret — на вкладке Overview проекта.</li>
          <li>
            В проекте подпишитесь на API-сервисы: «IoT Core» (статус и журнал устройства) и при
            желании «Smart Home Management».
          </li>
          <li>
            Привяжите датчик: Devices → Link Tuya App Device — отсканируйте QR-код из приложения
            Tuya Smart / Smart Life.
          </li>
          <li>
            ID устройства скопируйте из списка Devices в облаке или в приложении: устройство →
            карандаш → Device ID.
          </li>
        </ol>
      </div>
    </div>
  );
}
