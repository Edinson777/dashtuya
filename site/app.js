/* Статичный дашборд: читает ./data/latest.json (генерирует GitHub Actions).
   Поддерживает любое число датчиков: каждый рендерится отдельной секцией. */
(function () {
  'use strict';

  var COLORS = { temp: '#fbbf24', hum: '#22d3ee', grid: 'rgba(148,163,184,0.1)', tick: '#64748b' };
  var charts = [];

  var $ = function (id) { return document.getElementById(id); };
  var el = function (section, name) { return section.querySelector('[data-el="' + name + '"]'); };

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

  function renderChart(canvas, history) {
    var labels = history.map(function (h) {
      return new Date(h.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    });

    if (typeof Chart === 'undefined') return; // CDN недоступен — показываем только карточки

    charts.push(new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Температура',
            data: history.map(function (h) { return h.temp; }),
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
            data: history.map(function (h) { return h.hum; }),
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
    }));
  }

  function destroyCharts() {
    charts.forEach(function (c) { c.destroy(); });
    charts = [];
  }

  /* ---------- отрисовка секции одного датчика ---------- */

  function renderSection(section, sensor) {
    var device = sensor.device || {};

    /* заголовок и статус устройства */
    el(section, 'name').textContent = device.name || 'Датчик Tuya';
    var online = el(section, 'online');
    if (device.online === true) {
      online.hidden = false; online.className = 'badge ok'; online.textContent = 'Онлайн';
    } else if (device.online === false) {
      online.hidden = false; online.className = 'badge off'; online.textContent = 'Офлайн';
    } else {
      online.hidden = true;
    }

    /* секция с ошибкой: карточки скрываем, показываем причину */
    if (sensor.status === 'error') {
      el(section, 'error').hidden = false;
      el(section, 'error-text').textContent = sensor.error || 'Неизвестная ошибка — проверьте секреты Tuya в настройках Actions';
      el(section, 'body').hidden = true;
      return;
    }
    el(section, 'body').hidden = false;

    var current = sensor.current;
    var s = sensor.stats;

    /* температура */
    el(section, 'temp-value').textContent = current && current.temperature !== null && current.temperature !== undefined
      ? fmt(current.temperature) : '—';

    var temps = (sensor.history || []).map(function (h) { return h.temp; }).filter(function (v) { return v !== null; });
    var trendEl = el(section, 'temp-trend');
    if (temps.length >= 2) {
      var delta = temps[temps.length - 1] - temps[temps.length - 2];
      trendEl.textContent = Math.abs(delta) < 0.05 ? '— стабильно' : (delta > 0 ? '↗ +' : '↘ ') + fmt(delta) + '° за точку';
    } else {
      trendEl.textContent = '';
    }

    el(section, 'temp-stats').textContent = s && s.temp
      ? 'за 24 ч: мин ' + fmt(s.temp.min) + '° · ср. ' + fmt(s.temp.avg) + '° · макс ' + fmt(s.temp.max) + '°'
      : 'История за сутки появится после синхронизации';

    /* влажность */
    var hum = current ? current.humidity : null;
    el(section, 'hum-value').textContent = hum !== null && hum !== undefined ? fmt(hum, 0) : '—';
    var c = comfort(hum);
    var badge = el(section, 'hum-badge');
    if (c) { badge.hidden = false; badge.className = 'badge ' + c.cls; badge.textContent = c.label; }
    else { badge.hidden = true; }
    var marker = el(section, 'hum-marker');
    if (hum !== null && hum !== undefined && isFinite(hum)) {
      marker.hidden = false;
      marker.style.left = Math.min(100, Math.max(0, hum)) + '%';
    } else {
      marker.hidden = true;
    }
    el(section, 'hum-stats').textContent = s && s.hum
      ? 'за 24 ч: мин ' + fmt(s.hum.min, 0) + '% · ср. ' + fmt(s.hum.avg, 0) + '% · макс ' + fmt(s.hum.max, 0) + '%'
      : ' ';

    /* модель и батарея */
    el(section, 'device-model').textContent = device.model ? 'Модель: ' + device.model : '';
    var battery = current ? current.battery : null;
    if (battery !== null && battery !== undefined && isFinite(battery)) {
      el(section, 'battery-value').textContent = fmt(battery, 0) + '%';
      el(section, 'battery-fill').style.width = Math.min(100, Math.max(0, battery)) + '%';
    } else {
      el(section, 'battery-value').textContent = 'не сообщается';
      el(section, 'battery-fill').style.width = '0';
    }

    /* график */
    var history = sensor.history || [];
    var hasData = history.length >= 2;
    el(section, 'chart-empty').hidden = hasData;
    var canvas = el(section, 'chart');
    canvas.style.visibility = hasData ? 'visible' : 'hidden';
    if (hasData) renderChart(canvas, history);
  }

  function render(data) {
    destroyCharts();

    /* общий баннер: данные не собраны ни по одному датчику */
    if (data.status === 'error') {
      $('error-banner').hidden = false;
      $('error-text').textContent = data.error || 'Неизвестная ошибка — проверьте секреты Tuya в настройках Actions';
    } else {
      $('error-banner').hidden = true;
    }

    var sensors = data.sensors || [];
    var root = $('sensors-root');
    root.innerHTML = '';

    /* навигация по датчикам — только если их больше одного */
    var nav = $('sensor-nav');
    if (sensors.length > 1) {
      nav.innerHTML = '';
      sensors.forEach(function (sensor, i) {
        var a = document.createElement('a');
        a.href = '#sensor-' + i;
        a.textContent = (sensor.device && sensor.device.name) || 'Датчик ' + (i + 1);
        if (sensor.status === 'error') a.classList.add('broken');
        nav.appendChild(a);
      });
      nav.hidden = false;
    } else {
      nav.hidden = true;
    }

    var template = $('sensor-template');
    sensors.forEach(function (sensor, i) {
      var section = template.content.firstElementChild.cloneNode(true);
      section.id = 'sensor-' + i;
      root.appendChild(section);
      renderSection(section, sensor);
    });

    window.__lastGeneratedAt = data.generatedAt || null;
    $('sync-label').textContent = 'Обновлено ' + timeAgo(window.__lastGeneratedAt, Date.now());
  }

  function load() {
    var btn = $('refresh-btn');
    btn.disabled = true;
    btn.classList.add('spin');
    fetch('./data/latest.json?ts=' + Date.now(), { cache: 'no-store' })
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
  }

  $('refresh-btn').addEventListener('click', load);
  load();
  /* тикер «обновлено N назад» и мягкое обновление данных раз в 5 минут */
  setInterval(load, 5 * 60 * 1000);
  setInterval(function () {
    $('sync-label').textContent = 'Обновлено ' + timeAgo(window.__lastGeneratedAt || null, Date.now());
  }, 30000);
})();
