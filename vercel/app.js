/* Дашборд для Vercel: читает живой ответ /api/readings (serverless-функция опрашивает Tuya Cloud) */
(function () {
  'use strict';

  var DATA_URL = './api/readings';

  var COLORS = { temp: '#fbbf24', hum: '#22d3ee', grid: 'rgba(148,163,184,0.1)', tick: '#64748b' };
  var chart = null;

  var $ = function (id) { return document.getElementById(id); };

  function fmt(value, digits) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits == null ? 1 : digits });
  }

  function timeAgo(iso, nowMs) {
    if (!iso) return '—';
    var diff = nowMs - new Date(iso).getTime();
    if (!isFinite(diff) || diff < 0) return '—';
    if (diff < 15000) return 'только что';
    if (diff < 60000) return Math.floor(diff / 1000) + ' с назад';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч назад';
    return Math.floor(diff / 86400000) + ' дн назад';
  }

  function comfort(h) {
    if (h === null || h === undefined || !isFinite(h)) return null;
    if (h < 30) return { label: 'Сухо', cls: 'dry' };
    if (h > 60) return { label: 'Влажно', cls: 'wet' };
    return { label: 'Комфортно', cls: 'ok' };
  }

  /* Полоса комфорта 30–60% на правой оси */
  var comfortBand = {
    id: 'comfortBand',
    beforeDatasetsDraw: function (chartRef) {
      var ctx = chartRef.ctx;
      var yAxis = chartRef.scales.yHum;
      if (!yAxis) return;
      var top = yAxis.getPixelForValue(60);
      var bottom = yAxis.getPixelForValue(30);
      var area = chartRef.chartArea;
      ctx.save();
      ctx.fillStyle = 'rgba(34, 211, 238, 0.05)';
      ctx.fillRect(area.left, top, area.right - area.left, bottom - top);
      ctx.restore();
    }
  };

  function renderChart(history) {
    var labels = history.map(function (h) {
      return new Date(h.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    });
    var temps = history.map(function (h) { return h.temp; });
    var hums = history.map(function (h) { return h.hum; });

    if (chart) { chart.destroy(); chart = null; }
    if (typeof Chart === 'undefined') return; // CDN недоступен — показываем только карточки

    chart = new Chart($('chart'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Температура',
            data: temps,
            borderColor: COLORS.temp,
            backgroundColor: 'rgba(251, 191, 36, 0.12)',
            fill: true,
            yAxisID: 'yTemp',
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2,
            spanGaps: true
          },
          {
            label: 'Влажность',
            data: hums,
            borderColor: COLORS.hum,
            backgroundColor: 'rgba(34, 211, 238, 0.08)',
            fill: true,
            yAxisID: 'yHum',
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2,
            spanGaps: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            titleColor: '#cbd5e1',
            bodyColor: '#e2e8f0',
            padding: 10,
            callbacks: {
              label: function (item) {
                var unit = item.datasetIndex === 0 ? ' °C' : ' %';
                return ' ' + item.dataset.label + ': ' + fmt(item.parsed.y) + unit;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: COLORS.tick, font: { size: 11 }, maxTicksLimit: 10, maxRotation: 0 },
            border: { display: false }
          },
          yTemp: {
            position: 'left',
            grid: { color: COLORS.grid },
            ticks: { color: COLORS.tick, font: { size: 11 }, callback: function (v) { return v + '°'; } },
            border: { display: false }
          },
          yHum: {
            position: 'right',
            min: 0,
            max: 100,
            grid: { display: false },
            ticks: { color: COLORS.tick, font: { size: 11 }, callback: function (v) { return v + '%'; } },
            border: { display: false }
          }
        }
      },
      plugins: [comfortBand]
    });
  }

  function render(data) {
    var nowMs = Date.now();

    /* ошибка сбора */
    if (data.status === 'error') {
      $('error-banner').hidden = false;
      $('error-text').textContent = data.error || 'Неизвестная ошибка — проверьте переменные окружения Tuya в настройках проекта Vercel';
    } else {
      $('error-banner').hidden = true;
    }

    var current = data.current;

    /* температура */
    $('temp-value').textContent = current && current.temperature !== null && current.temperature !== undefined
      ? fmt(current.temperature) : '—';

    /* тренд по двум последним точкам истории */
    var temps = (data.history || []).map(function (h) { return h.temp; }).filter(function (v) { return v !== null; });
    var trendEl = $('temp-trend');
    if (temps.length >= 2) {
      var delta = temps[temps.length - 1] - temps[temps.length - 2];
      trendEl.textContent = Math.abs(delta) < 0.05 ? '— стабильно' : (delta > 0 ? '↗ +' : '↘ ') + fmt(delta) + '° за точку';
    } else {
      trendEl.textContent = '';
    }

    var s = data.stats;
    $('temp-stats').textContent = s && s.temp
      ? 'за 24 ч: мин ' + fmt(s.temp.min) + '° · ср. ' + fmt(s.temp.avg) + '° · макс ' + fmt(s.temp.max) + '°'
      : 'История за сутки появится после синхронизации';

    /* влажность */
    var hum = current ? current.humidity : null;
    $('hum-value').textContent = hum !== null && hum !== undefined ? fmt(hum, 0) : '—';
    var c = comfort(hum);
    var badge = $('hum-badge');
    if (c) { badge.hidden = false; badge.className = 'badge ' + c.cls; badge.textContent = c.label; }
    else { badge.hidden = true; }
    var marker = $('hum-marker');
    if (hum !== null && hum !== undefined && isFinite(hum)) {
      marker.hidden = false;
      marker.style.left = Math.min(100, Math.max(0, hum)) + '%';
    } else {
      marker.hidden = true;
    }
    $('hum-stats').textContent = s && s.hum
      ? 'за 24 ч: мин ' + fmt(s.hum.min, 0) + '% · ср. ' + fmt(s.hum.avg, 0) + '% · макс ' + fmt(s.hum.max, 0) + '%'
      : ' ';

    /* устройство */
    var device = data.device;
    $('device-name').textContent = (device && device.name) || 'Датчик Tuya';
    $('device-model').textContent = device && device.model ? 'Модель: ' + device.model : '';
    var onlineBadge = $('device-online');
    if (device && device.online === true) {
      onlineBadge.hidden = false; onlineBadge.className = 'badge ok'; onlineBadge.textContent = 'Онлайн';
    } else if (device && device.online === false) {
      onlineBadge.hidden = false; onlineBadge.className = 'badge off'; onlineBadge.textContent = 'Офлайн';
    } else {
      onlineBadge.hidden = true;
    }

    /* батарея */
    var battery = current ? current.battery : null;
    if (battery !== null && battery !== undefined && isFinite(battery)) {
      $('battery-value').textContent = fmt(battery, 0) + '%';
      $('battery-fill').style.width = Math.min(100, Math.max(0, battery)) + '%';
    } else {
      $('battery-value').textContent = 'не сообщается';
      $('battery-fill').style.width = '0';
    }

    /* график */
    var history = data.history || [];
    var hasData = history.length >= 2;
    $('chart-empty').hidden = hasData;
    $('chart').style.visibility = hasData ? 'visible' : 'hidden';
    if (hasData) renderChart(history);

    /* время обновления */
    window.__lastGeneratedAt = data.generatedAt || (current && current.recordedAt) || null;
    $('sync-label').textContent = 'Обновлено ' + timeAgo(window.__lastGeneratedAt, nowMs);
  }

  function load() {
    var btn = $('refresh-btn');
    var icon = $('refresh-icon');
    btn.disabled = true;
    btn.classList.add('spin');
    fetch(DATA_URL + '?ts=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        render(data);
      })
      .catch(function (err) {
        $('error-banner').hidden = false;
        $('error-text').textContent = 'Не удалось загрузить данные: ' + err.message;
      })
      .finally(function () {
        btn.disabled = false;
        btn.classList.remove('spin');
      });
    void icon;
  }

  $('refresh-btn').addEventListener('click', load);
  load();
  /* тикер «обновлено N назад» и обновление данных раз в 5 минут
     (функция кэшируется на edge Vercel на 5 минут, поэтому чаще и незачем) */
  setInterval(load, 5 * 60 * 1000);
  setInterval(function () {
    $('sync-label').textContent = 'Обновлено ' + timeAgo(window.__lastGeneratedAt || null, Date.now());
  }, 30000);
})();
