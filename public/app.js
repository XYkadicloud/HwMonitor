/* HwMonitor dashboard client.
   No frameworks and no build step: the whole app is served as-is so it runs on
   a low-power machine with nothing to install. */
'use strict';

// ---------------------------------------------------------------- utilities
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/** Format bytes with a sensible unit. */
function fmtBytes(n, digits = 1) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(digits)} ${units[i]}`;
}

/** Format a byte/second rate. */
function fmtRate(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return `${fmtBytes(n, 1)}/s`;
}

/** Format an integer with thousands separators. */
function fmtInt(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/** Compact large token counts: 1234567 -> 1.23M */
function fmtTokens(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(2)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

function fmtPct(n, digits = 0) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return `${Number(n).toFixed(digits)}%`;
}

function fmtMwh(mwh) {
  if (mwh === null || mwh === undefined) return '—';
  if (mwh >= 1000) return `${(mwh / 1000).toFixed(2)} Wh`;
  return `${Math.round(mwh)} mWh`;
}

function fmtMw(mw) {
  if (mw === null || mw === undefined || !isFinite(mw)) return '—';
  return `${(mw / 1000).toFixed(2)} W`;
}

function fmtMinutes(min) {
  if (min === null || min === undefined || !isFinite(min) || min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m} 分钟`;
  return `${h} 小时 ${m} 分`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小时`;
}

function fmtAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 5000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Escape text for safe insertion via innerHTML. */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function setText(id, value) {
  const el = $(id);
  if (el && el.textContent !== value) el.textContent = value;
}

/** Colour a value by how alarming it is. */
function loadColor(pct) {
  if (pct >= 90) return 'var(--danger)';
  if (pct >= 75) return 'var(--warn)';
  return 'var(--accent)';
}

// ------------------------------------------------------------------- state
const state = {
  hello: null,
  sample: null,
  inventory: null,
  dsh: null,
  config: null,
  thresholds: null,
  services: [],
  neverStop: [],
  addresses: null,
  series: [],
  history: [],
  connected: false,
  lastSampleAt: 0,
  view: 'live',
};

const MAX_HISTORY = 900; // ~30 min at a 2s cadence

// ------------------------------------------------------------------- charts
/** Minimal line-chart renderer on a canvas, DPR-aware. */
class Chart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.series = opts.series || [];
    this.min = opts.min !== undefined ? opts.min : 0;
    this.max = opts.max !== undefined ? opts.max : 100;
    this.autoMax = opts.autoMax !== false;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const h = this.opts.height || 60;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.height = `${h}px`;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = h;
  }

  draw(data) {
    if (!this.ctx) this.resize();
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (!data || !data.length) {
      ctx.fillStyle = 'rgba(147,161,189,.5)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('等待数据…', 6, h / 2 + 4);
      return;
    }

    // Determine the value range.
    let lo = this.min;
    let hi = this.max;
    if (this.autoMax) {
      hi = -Infinity;
      for (const s of this.series) {
        for (const v of data) {
          const val = v[s.key];
          if (val !== null && val !== undefined && isFinite(val) && val > hi) hi = val;
        }
      }
      if (!isFinite(hi) || hi <= 0) hi = 1;
      hi *= 1.15;
    }

    const pad = 2;
    const plotH = h - pad * 2;
    const n = data.length;
    const stepX = n > 1 ? w / (n - 1) : w;

    // Horizontal reference lines.
    ctx.strokeStyle = 'rgba(147,161,189,.16)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = pad + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Zero baseline, drawn brighter when the range straddles zero. Without it a
    // signed series (power: discharge positive, charge negative) is ambiguous.
    if (lo < 0 && hi > 0) {
      const zeroY = pad + plotH - ((0 - lo) / (hi - lo || 1)) * plotH;
      ctx.strokeStyle = 'rgba(147,161,189,.45)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(w, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const s of this.series) {
      ctx.beginPath();
      let started = false;
      let firstX = 0;
      let lastX = 0;
      let lastY = 0;
      for (let i = 0; i < n; i++) {
        const raw = data[i][s.key];
        if (raw === null || raw === undefined || !isFinite(raw)) continue;
        const x = i * stepX;
        const y = pad + plotH - ((raw - lo) / (hi - lo || 1)) * plotH;
        if (!started) { ctx.moveTo(x, y); started = true; firstX = x; }
        else ctx.lineTo(x, y);
        lastX = x; lastY = y;
      }
      if (!started) continue;

      // Filled area under the line for readability at small sizes.
      if (s.fill) {
        ctx.save();
        ctx.lineTo(lastX, h);
        ctx.lineTo(firstX, h);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, s.fill);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
        // The path was consumed by fill(); redraw the stroke.
        ctx.beginPath();
        let st2 = false;
        for (let i = 0; i < n; i++) {
          const raw = data[i][s.key];
          if (raw === null || raw === undefined || !isFinite(raw)) continue;
          const x = i * stepX;
          const y = pad + plotH - ((raw - lo) / (hi - lo || 1)) * plotH;
          if (!st2) { ctx.moveTo(x, y); st2 = true; } else ctx.lineTo(x, y);
        }
      }

      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.6;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    // Right-edge current-value dots.
    for (const s of this.series) {
      for (let i = n - 1; i >= 0; i--) {
        const raw = data[i][s.key];
        if (raw === null || raw === undefined || !isFinite(raw)) continue;
        const x = i * stepX;
        const y = pad + plotH - ((raw - lo) / (hi - lo || 1)) * plotH;
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        break;
      }
    }
  }
}

let charts = {};

function initCharts() {
  charts = {
    power: new Chart($('chart-power'), { height: 60, autoMax: false, min: -10, max: 10, series: [
      { key: 'power', color: '#fbbf24', fill: 'rgba(251,191,36,.28)' },
    ] }),
    disk: new Chart($('chart-disk'), { height: 60, autoMax: true, series: [
      { key: 'diskRead', color: '#60a5fa' },
      { key: 'diskWrite', color: '#f472b6' },
    ] }),
    net: new Chart($('chart-net'), { height: 60, autoMax: true, series: [
      { key: 'netRx', color: '#4ade80' },
      { key: 'netTx', color: '#fbbf24' },
    ] }),
    history: new Chart($('chart-history'), { height: 140, autoMax: false, max: 100, series: [
      { key: 'cpu', color: '#4ade80', fill: 'rgba(74,222,128,.18)' },
      { key: 'mem', color: '#60a5fa' },
      { key: 'gpu', color: '#f472b6' },
      { key: 'powerScaled', color: '#fbbf24' },
    ] }),
  };
  for (const c of Object.values(charts)) c.resize();
}

function redrawCharts() {
  const hist = state.history;

  // Power is signed: positive = discharging, negative = charging. The scale is
  // taken from the largest magnitude in the window so both directions fit, and
  // the chart is told about the negative range so it can plot below zero.
  let powerPeak = 0;
  for (const h of hist) {
    if (h.power !== null && h.power !== undefined && isFinite(h.power)) {
      powerPeak = Math.max(powerPeak, Math.abs(h.power));
    }
  }
  if (powerPeak < 1) powerPeak = 1;
  charts.power.min = -powerPeak * 1.15;
  charts.power.max = powerPeak * 1.15;

  // The history chart shares one 0-100 axis; power magnitude is normalised
  // against the window's own peak so it stays readable alongside percentages.
  const histData = hist.map((h) => ({
    ...h,
    powerScaled: h.power === null || h.power === undefined
      ? null
      : (Math.abs(h.power) / powerPeak) * 100,
  }));

  charts.power.draw(hist);
  charts.disk.draw(hist);
  charts.net.draw(hist);
  charts.history.draw(histData);

  if (powerPeak > 1) {
    const charging = hist.some((h) => h.power !== null && h.power < 0);
    const discharging = hist.some((h) => h.power !== null && h.power > 0);
    const dir = charging && discharging ? '放电为正、充电为负'
      : charging ? '充电输入功率（负值）'
      : '放电功率';
    setText('hist-note', `功耗曲线：${dir}，按窗口峰值 ${(powerPeak / 1000).toFixed(2)} W 缩放；其余为百分比。`);
  }
}

// --------------------------------------------------------------- rendering
function renderAlerts(sample) {
  const box = $('alerts');
  if (!box) return;
  if (!sample) { box.innerHTML = ''; return; }

  const th = state.thresholds || {};
  const alerts = [];
  const b = sample.battery;
  if (b && b.present && b.percent !== null && b.percent !== undefined) {
    const low = th.batteryLowPct || 20;
    if (b.percent <= low) {
      alerts.push({ level: b.percent <= low / 2 ? 'danger' : 'warn', text: `电量偏低：${fmtPct(b.percent, 1)}（阈值 ${low}%）` });
    }
  }
  for (const v of sample.volumes || []) {
    const low = th.diskLowFreePct || 10;
    if (v.freePct !== null && v.freePct !== undefined && v.freePct <= low) {
      alerts.push({ level: v.freePct <= low / 2 ? 'danger' : 'warn', text: `${v.id} 剩余空间不足：${fmtPct(v.freePct, 1)}（阈值 ${low}%）` });
    }
  }
  if (sample.cpu && sample.cpu.totalPct >= (th.cpuHighPct || 90)) {
    alerts.push({ level: 'warn', text: `CPU 占用高：${fmtPct(sample.cpu.totalPct, 1)}` });
  }
  if (sample.memory && sample.memory.usedPct >= (th.memoryHighPct || 90)) {
    alerts.push({ level: 'warn', text: `内存占用高：${fmtPct(sample.memory.usedPct, 1)}` });
  }
  if (!state.connected) {
    alerts.push({ level: 'info', text: '正在重新连接数据流…' });
  }
  if (sample.selfCostMs && sample.selfCostMs > (state.config ? state.config.refreshMs : 2000) * 0.6) {
    alerts.push({ level: 'info', text: `监控自身采样开销偏高：${sample.selfCostMs} ms/次，可在设置中增大采样间隔。` });
  }

  box.innerHTML = alerts.map((a) => `<div class="alert ${a.level}">${esc(a.text)}</div>`).join('');
}

function setGauge(arcId, valueId, pct, color) {
  const arc = $(arcId);
  const CIRC = 326.73;
  const p = Math.max(0, Math.min(100, pct === null || pct === undefined || !isFinite(pct) ? 0 : pct));
  if (arc) {
    arc.style.strokeDashoffset = String(CIRC * (1 - p / 100));
    arc.style.stroke = color || 'var(--accent)';
  }
  setText(valueId, pct === null || pct === undefined || !isFinite(pct) ? '—' : String(Math.round(pct)));
}

function renderLive() {
  const s = state.sample;
  const hello = state.hello;

  // Connection indicator.
  const dot = $('conn-dot');
  if (dot) {
    dot.className = 'dot ' + (state.connected ? 'ok' : 'bad');
    dot.title = state.connected ? '数据流已连接' : '数据流已断开';
  }

  if (hello && hello.static) {
    setText('host-name', `${hello.static.computerName || ''} · ${hello.static.osName || ''}`);
    setText('cpu-name', hello.static.cpuName || '—');
    setText('cpu-cores', `${hello.static.cpuCores || '?'} / ${hello.static.cpuThreads || '?'}`);
    setText('mem-total', `共 ${fmtBytes(hello.static.totalMemoryBytes)}`);
    const gpu = state.inventory && state.inventory.gpus && state.inventory.gpus[0];
    setText('gpu-name', gpu ? gpu.name : '—');
  }

  if (!s) { renderAlerts(null); return; }

  // --- Battery
  const b = s.battery || {};
  const batStatic = (hello && hello.batteryStatic) || {};
  if (b.present) {
    setGauge('battery-arc', 'battery-pct', b.percent, b.percent <= 20 ? 'var(--danger)' : b.percent <= 40 ? 'var(--warn)' : 'var(--accent)');
    const stateText = b.charging ? '充电中' : b.discharging ? '放电中' : b.acOnline ? '已接电源' : '未知';
    const badge = $('battery-state');
    if (badge) {
      badge.textContent = stateText;
      badge.className = 'badge ' + (b.charging ? 'ok' : b.discharging && b.percent <= 20 ? 'danger' : '');
    }
    setText('battery-remaining', fmtMwh(b.remainingMwh));
    setText('battery-full', fmtMwh(b.fullChargeCapacityMwh || batStatic.fullChargeCapacityMwh));
    setText('battery-design', fmtMwh(b.designCapacityMwh || batStatic.designCapacityMwh));
    setText('battery-health', batStatic.healthPct !== undefined ? `${batStatic.healthPct}%` : '—');
    setText('battery-cycles', batStatic.cycleCount !== undefined ? `${batStatic.cycleCount} 次` : '—');
    setText('battery-voltage', b.voltageMv ? `${(b.voltageMv / 1000).toFixed(3)} V` : '—');
    setText('battery-power', b.discharging ? fmtMw(b.dischargeMw) : b.charging ? `充电 ${fmtMw(b.chargeMw)}` : '—');
    setText('battery-runtime', b.discharging ? fmtMinutes(b.runtimeMinutes) : b.charging && b.minutesToFull ? `充满约 ${fmtMinutes(b.minutesToFull)}` : '—');
  } else {
    setText('battery-state', '无电池');
    setText('battery-pct', '—');
    setGauge('battery-arc', 'battery-pct', null);
    for (const id of ['battery-remaining', 'battery-full', 'battery-design', 'battery-health', 'battery-cycles', 'battery-voltage', 'battery-power', 'battery-runtime']) setText(id, '—');
  }

  // --- CPU
  const c = s.cpu || {};
  setGauge('cpu-arc', 'cpu-pct', c.totalPct, loadColor(c.totalPct || 0));
  setText('cpu-user', c.userPct !== undefined ? fmtPct(c.userPct, 1) : '—');
  setText('cpu-priv', c.privilegedPct !== undefined ? fmtPct(c.privilegedPct, 1) : '—');
  setText('cpu-mhz', c.currentMhz ? `${fmtInt(c.currentMhz)} MHz` : '—');

  const coreBox = $('core-bars');
  if (coreBox) {
    const cores = c.cores || [];
    if (cores.length !== coreBox.children.length) {
      coreBox.innerHTML = cores.map((core, i) => `
        <div class="core-bar">
          <span class="label">#${esc(core.name || i)}</span>
          <span class="track"><span class="fill" data-core="${i}"></span></span>
          <span class="val" data-coreval="${i}">—</span>
        </div>`).join('');
    }
    cores.forEach((core, i) => {
      const fill = coreBox.querySelector(`[data-core="${i}"]`);
      const val = coreBox.querySelector(`[data-coreval="${i}"]`);
      if (fill) { fill.style.width = `${Math.max(0, Math.min(100, core.pct || 0))}%`; fill.style.background = loadColor(core.pct || 0); }
      if (val) val.textContent = fmtPct(core.pct, 0);
    });
  }

  // --- Memory
  const m = s.memory || {};
  setGauge('mem-arc', 'mem-pct', m.usedPct, loadColor(m.usedPct || 0));
  setText('mem-used', fmtBytes(m.usedBytes));
  setText('mem-avail', fmtBytes(m.availableBytes));
  setText('mem-commit', m.committedBytes ? fmtBytes(m.committedBytes) : '—');
  setText('mem-cache', m.cacheBytes ? fmtBytes(m.cacheBytes) : '—');

  // --- GPU
  const g = s.gpu || {};
  if (g.supported) {
    setGauge('gpu-arc', 'gpu-pct', g.maxEnginePct, loadColor(g.maxEnginePct || 0));
    setText('gpu-engines', String(g.engineCount || 0));
    setText('gpu-sampled', g.sampled ? '最新' : '沿用上次');
    setText('gpu-note', 'GPU 利用率取最繁忙引擎的读数，采样频率低于其他指标。');
  } else {
    setGauge('gpu-arc', 'gpu-pct', null);
    setText('gpu-engines', '—');
    setText('gpu-sampled', '—');
    setText('gpu-note', '此系统未提供 GPU 性能计数器。');
  }

  // --- Power
  // The collector emits an explicit power block so the meaning of the number is
  // never ambiguous: while charging it is the input power going into the
  // battery, while discharging it is the whole-system draw. Wording comes from
  // the shared labels module so the native GUI says exactly the same thing.
  const pw = s.power || (b.power || null);
  const powerEl = $('power-now');
  if (powerEl) {
    const hasWatts = pw && pw.watts !== null && pw.watts !== undefined && isFinite(pw.watts);
    powerEl.textContent = hasWatts ? Number(pw.watts).toFixed(2) : '—';
    powerEl.style.color = pw && pw.mode === 'charging' ? 'var(--accent2)'
      : pw && pw.mode === 'ac-idle' ? 'var(--warn)'
      : 'var(--accent)';
  }
  if (pw) {
    setText('power-source', HWM_LABELS.powerLabel(pw.mode));
    setText('power-note', HWM_LABELS.powerNote(pw.mode));
  } else {
    setText('power-source', b.present ? '电池读数' : '无电池');
    setText('power-note', b.present
      ? '整机功耗来自电池放电/充电速率的真实读数（WMI BatteryStatus）。'
      : '此设备没有可读的电池功耗数据。');
  }

  // --- Disk IO
  const io = s.diskIo || {};
  setText('disk-read', fmtRate(io.readBytesPerSec));
  setText('disk-write', fmtRate(io.writeBytesPerSec));
  setText('disk-busy', io.busyPct !== undefined ? `忙 ${fmtPct(io.busyPct, 1)}` : '—');
  setText('disk-queue', io.queueLength !== undefined ? `队列长度 ${io.queueLength}` : '—');

  // --- Network
  const net = s.network || {};
  setText('net-rx', fmtRate(net.rxBytesPerSec));
  setText('net-tx', fmtRate(net.txBytesPerSec));
  const adapters = net.adapters || [];
  setText('net-adapter', adapters.length ? adapters[0].name : '无活动适配器');
  setText('net-note', adapters.length > 1 ? `共 ${adapters.length} 个活动适配器，数值为合计。` : '数值为所有网络适配器合计。');

  // --- Volumes
  const volBox = $('volumes');
  const vols = s.volumes || [];
  setText('vol-count', `${vols.length} 个卷`);
  if (volBox) {
    volBox.innerHTML = vols.map((v) => {
      const cls = v.freePct <= 5 ? 'danger' : v.freePct <= 12 ? 'warn' : '';
      const label = v.label ? `${v.id} ${esc(v.label)}` : v.id;
      return `
        <div class="volume">
          <div class="volume-top">
            <strong>${esc(label)}</strong>
            <span class="muted">${fmtBytes(v.usedBytes)} / ${fmtBytes(v.sizeBytes)} · 剩余 ${fmtBytes(v.freeBytes)}</span>
          </div>
          <div class="volume-bar"><div class="volume-fill ${cls}" style="width:${Math.max(0, Math.min(100, v.usedPct || 0))}%"></div></div>
          <div class="volume-sub">已用 ${fmtPct(v.usedPct, 1)} · ${esc(v.fs)}</div>
        </div>`;
    }).join('');
  }

  // --- Processes
  const tbody = $('proc-table') && $('proc-table').querySelector('tbody');
  if (tbody) {
    const procs = s.processes || [];
    tbody.innerHTML = procs.map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td class="muted">${p.pid}</td>
        <td class="num">${fmtPct(p.cpuPct, 1)}</td>
        <td class="num">${p.memMb} MB</td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">暂无数据</td></tr>';
  }

  // --- System
  const sys = s.system || {};
  setText('sys-uptime', fmtDuration((sys.uptimeSeconds || 0) * 1000));
  setText('uptime', sys.uptimeSeconds ? `已运行 ${fmtDuration(sys.uptimeSeconds * 1000)}` : '—');
  setText('sys-procs', `${sys.processCount || '—'} / ${sys.threadCount || '—'}`);
  setText('sys-queue', sys.processorQueue !== undefined ? String(sys.processorQueue) : '—');
  setText('sys-ctx', sys.contextSwitchesPerSec ? `${fmtInt(sys.contextSwitchesPerSec)}/s` : '—');

  const th = s.thermal || {};
  if (th.supported && th.zones && th.zones.length) {
    setText('sys-temp', th.zones.map((z) => `${z.celsius}°C`).join(' / '));
    setText('temp-note', '');
  } else {
    setText('sys-temp', '不支持');
    setText('temp-note', '此系统未暴露 ACPI 温度传感器，因此不显示温度（而非显示猜测值）。');
  }

  setText('sys-self', s.selfCostMs !== undefined ? `${s.selfCostMs} ms/次` : '—');

  renderAlerts(s);
  redrawCharts();
}

function renderDsh() {
  const r = state.dsh;
  if (!r) return;

  const cur = r.sessions && r.sessions.length ? r.sessions[0] : null;

  setText('dsh-scan', r.scannedAt ? `扫描于 ${fmtAgo(r.scannedAt)}` : '未扫描');
  setText('dsh-total-tokens', fmtTokens(r.grand.inputTokens + r.grand.outputTokens));
  setText('dsh-in', fmtInt(r.grand.inputTokens));
  setText('dsh-out', fmtInt(r.grand.outputTokens));
  setText('dsh-reasoning', fmtInt(r.grand.reasoningTokens));
  setText('dsh-cache', fmtInt(r.grand.cacheReadTokens));

  const currency = (state.config && state.config.pricing && state.config.pricing.currency) || 'CNY';
  setText('dsh-currency', currency);
  const anyPriced = r.byModel.some((m) => {
    const pr = state.config && state.config.pricing && state.config.pricing.models && state.config.pricing.models[`${m.provider}/${m.model}`];
    return pr && (Number(pr.input) > 0 || Number(pr.output) > 0);
  });
  setText('dsh-cost', anyPriced ? r.grand.cost.toFixed(4) : '0.0000');
  setText('dsh-calls', fmtInt(r.grand.calls));
  setText('dsh-sessions', String(r.grand.sessions));
  setText('dsh-active', String(r.grand.activeSessions));
  setText('dsh-scanms', r.scanMs !== undefined ? `${r.scanMs} ms` : '—');
  setText('dsh-pricing-note', anyPriced
    ? '费用按「设置」中填写的单价估算。'
    : '所有模型单价当前为 0，因此费用为 0。请在「设置 → 模型单价」中填入真实单价。');

  // Current session.
  if (cur) {
    setText('dsh-cur-state', cur.active ? '进行中' : '已结束');
    const badge = $('dsh-cur-state');
    if (badge) badge.className = 'badge ' + (cur.active ? 'ok' : '');
    setText('dsh-cur-title', cur.title || '(无标题)');
    setText('dsh-cur-cwd', cur.cwd || '');
    setText('dsh-cur-turns', String(cur.turns));
    setText('dsh-cur-steps', String(cur.steps));
    setText('dsh-cur-tokens', `${fmtTokens(cur.tokens.input)} / ${fmtTokens(cur.tokens.output)}`);
    setText('dsh-cur-span', fmtDuration(cur.spanMs));

    const todoBox = $('dsh-cur-todos');
    if (todoBox) {
      if (cur.todos && cur.todos.length) {
        todoBox.innerHTML = cur.todos.map((t) => {
          const done = t.status === 'completed';
          const active = t.status === 'in_progress';
          const mark = done ? '✔' : active ? '▶' : '○';
          return `<div class="todo-item ${done ? 'done' : active ? 'active' : ''}"><span class="mark">${mark}</span><span>${esc(t.content)}</span></div>`;
        }).join('');
      } else {
        todoBox.innerHTML = '<div class="muted" style="font-size:12px">无待办列表</div>';
      }
    }
  } else {
    setText('dsh-cur-state', '无会话');
    setText('dsh-cur-title', '—');
    setText('dsh-cur-cwd', '');
    setText('dsh-cur-turns', '—');
    setText('dsh-cur-steps', '—');
    setText('dsh-cur-tokens', '—');
    setText('dsh-cur-span', '—');
  }

  // DSH processes (from the live hardware sample).
  const s = state.sample;
  const dshProcs = (s && s.dshProcesses) || [];
  setText('dsh-proc-count', `${dshProcs.length} 个进程`);
  const pbody = $('dsh-proc-table') && $('dsh-proc-table').querySelector('tbody');
  if (pbody) {
    pbody.innerHTML = dshProcs
      .sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0))
      .map((p) => `
        <tr>
          <td>${esc(HWM_LABELS.dshRoleLabel(p.role))}</td>
          <td class="muted">${p.pid}</td>
          <td class="num">${fmtPct(p.cpuPct, 1)}</td>
          <td class="num">${p.memMb} MB</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">未检测到 DSH 进程</td></tr>';
  }

  // Per-model table.
  const mbody = $('dsh-model-table') && $('dsh-model-table').querySelector('tbody');
  if (mbody) {
    mbody.innerHTML = r.byModel.map((m) => `
      <tr>
        <td>${esc(m.provider)}/<strong>${esc(m.model)}</strong></td>
        <td class="num">${fmtInt(m.calls)}</td>
        <td class="num">${fmtTokens(m.inputTokens)}</td>
        <td class="num">${fmtTokens(m.outputTokens)}</td>
        <td class="num">${anyPriced ? m.cost.toFixed(4) : '—'}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">暂无数据</td></tr>';
  }

  // Tool usage bars.
  const toolBox = $('dsh-tool-bars');
  const tools = r.byTool.slice(0, 12);
  const maxTool = tools.length ? tools[0].count : 1;
  setText('dsh-tool-total', `${r.byTool.reduce((a, t) => a + t.count, 0)} 次调用`);
  if (toolBox) {
    toolBox.innerHTML = tools.map((t) => `
      <div class="tool-bar">
        <span class="name" title="${esc(t.name)}">${esc(t.name)}</span>
        <span class="track"><span class="fill" style="width:${(t.count / maxTool) * 100}%"></span></span>
        <span class="val">${fmtInt(t.count)}</span>
      </div>`).join('') || '<div class="muted">暂无数据</div>';
  }

  // Session table.
  const sbody = $('dsh-session-table') && $('dsh-session-table').querySelector('tbody');
  if (sbody) {
    sbody.innerHTML = r.sessions.slice(0, 60).map((x) => `
      <tr>
        <td>${esc((x.title || '(无标题)').slice(0, 40))}${x.active ? ' <span class="badge ok">进行中</span>' : ''}</td>
        <td class="muted">${esc(x.cwd || '')}</td>
        <td class="num">${x.turns}</td>
        <td class="num">${fmtInt(x.steps)}</td>
        <td class="num">${fmtTokens(x.tokens.input)}</td>
        <td class="num">${fmtTokens(x.tokens.output)}</td>
        <td class="num">${anyPriced ? x.cost.toFixed(4) : '—'}</td>
        <td class="muted">${fmtAgo(x.lastEventAt)}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">暂无会话</td></tr>';
  }

  // Daily usage.
  const dayBox = $('dsh-day-bars');
  if (dayBox) {
    const days = r.byDay.slice(-14);
    const maxDay = Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens));
    dayBox.innerHTML = days.map((d) => {
      const total = d.inputTokens + d.outputTokens;
      const inPct = (d.inputTokens / maxDay) * 100;
      const outPct = (d.outputTokens / maxDay) * 100;
      return `
        <div class="day-bar">
          <span class="day">${esc(d.day)}</span>
          <span class="track">
            <span class="fill-in" style="width:${inPct}%"></span>
            <span class="fill-out" style="width:${outPct}%"></span>
          </span>
          <span class="val">${fmtTokens(total)} · ${d.sessions} 会话</span>
        </div>`;
    }).join('') || '<div class="muted">暂无数据</div>';
  }

  const rootNote = $('about-dsh-root');
  if (rootNote) rootNote.textContent = `DSH 会话日志目录：${r.sessionsRoot}`;
}

function renderHardware() {
  const inv = state.inventory;
  if (!inv || inv.pending) {
    setText('inv-system', '正在采集硬件信息…（首次约需 20 秒）');
    return;
  }

  const kv = (obj) => Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

  const sys = inv.system || {};
  const osInfo = inv.os || {};
  $('inv-system').innerHTML = kv({
    计算机名: sys.computerName,
    厂商: sys.manufacturer,
    型号: sys.model,
    系统类型: sys.systemType,
    操作系统: `${osInfo.name || ''} ${osInfo.displayVersion || ''}`,
    版本号: osInfo.build,
    安装日期: osInfo.installDate ? new Date(osInfo.installDate).toLocaleDateString('zh-CN') : null,
    物理内存: fmtBytes(sys.totalPhysicalBytes),
    BIOS: inv.bios ? `${inv.bios.vendor || ''} ${inv.bios.version || ''}` : null,
    序列号: inv.bios ? inv.bios.serial : null,
    采集时间: inv.generatedAt ? fmtTime(new Date(inv.generatedAt).getTime()) : null,
  });

  const b = inv.battery || {};
  $('inv-battery').innerHTML = b.present ? kv({
    型号: b.name,
    化学体系: b.chemistry === 6 ? '锂离子 (Li-ion)' : b.chemistry,
    设计容量: fmtMwh(b.designCapacityMwh),
    满充容量: fmtMwh(b.fullChargeCapacityMwh),
    健康度: b.healthPct !== undefined ? `${b.healthPct}%` : null,
    循环次数: b.cycleCount !== undefined ? `${b.cycleCount} 次` : null,
    设计电压: b.designVoltageMv ? `${(b.designVoltageMv / 1000).toFixed(3)} V` : null,
  }) : '<div class="muted">未检测到电池</div>';

  const cpu = (inv.cpus && inv.cpus[0]) || {};
  $('inv-cpu').innerHTML = kv({
    型号: cpu.name,
    核心: cpu.cores,
    线程: cpu.threads,
    最大频率: cpu.maxClockMhz ? `${cpu.maxClockMhz} MHz` : null,
    当前频率: cpu.currentClockMhz ? `${cpu.currentClockMhz} MHz` : null,
    插槽: cpu.socket,
    虚拟化: cpu.virtualizationFirmwareEnabled ? '已启用' : '未启用',
  });

  const mods = inv.memoryModules || [];
  const memRows = mods.map((m, i) =>
    `<div><dt>插槽 ${i + 1} (${esc(m.slot || m.bank || '')})</dt><dd>${fmtBytes(m.capacityBytes)} · ${m.speedMhz} MHz · ${esc(m.manufacturer || '')}</dd></div>`
  ).join('');
  $('inv-memory').innerHTML = (memRows || '<div class="muted">未读取到内存条信息</div>') +
    `<div><dt>插槽总数</dt><dd>${inv.memorySlots || '—'}</dd></div>` +
    `<div><dt>最大支持</dt><dd>${inv.memoryMaxCapacityKb ? fmtBytes(inv.memoryMaxCapacityKb * 1024) : '—'}</dd></div>`;

  const dbody = $('inv-disks') && $('inv-disks').querySelector('tbody');
  if (dbody) {
    dbody.innerHTML = (inv.physicalDisks || []).map((d) => `
      <tr>
        <td>${esc(d.name)}</td>
        <td>${esc(d.mediaType)}</td>
        <td>${esc(d.busType)}</td>
        <td class="num">${fmtBytes(d.sizeBytes)}</td>
        <td>${d.health === 'Healthy' ? '✅ 正常' : esc(d.health)}</td>
        <td class="muted">${esc(d.serial || '')}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">无数据</td></tr>';
  }

  const gbody = $('inv-gpus') && $('inv-gpus').querySelector('tbody');
  if (gbody) {
    gbody.innerHTML = (inv.gpus || []).map((g) => `
      <tr>
        <td>${esc(g.name)}</td>
        <td class="muted">${esc(g.driverVersion || '')}</td>
        <td>${g.currentHorizontalResolution ? `${g.currentHorizontalResolution}×${g.currentVerticalResolution} @ ${g.currentRefreshRate}Hz` : '—'}</td>
        <td class="num">${g.adapterRamBytes ? fmtBytes(g.adapterRamBytes) : '—'}</td>
        <td>${esc(g.status || '')}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">无数据</td></tr>';
  }

  const nbody = $('inv-net') && $('inv-net').querySelector('tbody');
  if (nbody) {
    nbody.innerHTML = (inv.networkAdapters || []).map((n) => `
      <tr>
        <td>${esc(n.name || '')}</td>
        <td class="muted">${esc(n.description || '')}</td>
        <td>${esc(n.status || '')}</td>
        <td>${esc(n.linkSpeed || '')}</td>
        <td class="muted">${esc(n.macAddress || '')}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">无数据</td></tr>';
  }

  const caps = $('about-caps');
  if (caps && state.hello && state.hello.capabilities) {
    const c = state.hello.capabilities;
    caps.textContent = `传感器支持情况：CPU ${c.cpu ? '✅' : '❌'} · 内存 ${c.memory ? '✅' : '❌'} · 磁盘 ${c.disk ? '✅' : '❌'} · 网络 ${c.network ? '✅' : '❌'} · GPU ${c.gpu ? '✅' : '❌'} · 温度 ${c.thermal ? '✅' : '❌（此机器不支持）'} · 电池 ${c.battery ? '✅' : '❌'}`;
  }
}

function renderSettings() {
  const c = state.config;
  if (!c) return;

  const form = $('settings-form');
  if (form) {
    form.refreshMs.value = c.refreshMs;
    form.historyMinutes.value = c.historyMinutes;
    form.batteryLowPct.value = c.thresholds.batteryLowPct;
    form.diskLowFreePct.value = c.thresholds.diskLowFreePct;
    form.cpuHighPct.value = c.thresholds.cpuHighPct;
    form.memoryHighPct.value = c.thresholds.memoryHighPct;
    form.password.placeholder = c.passwordSet ? '已设置（留空保持不变，输入新口令可更改）' : '留空则不需要口令';
  }

  const pf = $('pricing-form');
  if (pf) {
    pf.currency.value = c.pricing.currency || 'CNY';
    pf['def-input'].value = c.pricing.defaultRates.input;
    pf['def-output'].value = c.pricing.defaultRates.output;
    pf['def-cacheRead'].value = c.pricing.defaultRates.cacheRead;
  }

  // Pricing rows: every model seen in DSH logs plus anything already configured.
  const rows = $('pricing-rows');
  if (rows) {
    const keys = new Set(Object.keys(c.pricing.models || {}));
    if (state.dsh && state.dsh.byModel) {
      for (const m of state.dsh.byModel) keys.add(`${m.provider}/${m.model}`);
    }
    rows.innerHTML = Array.from(keys).map((key) => {
      const r = (c.pricing.models && c.pricing.models[key]) || { input: 0, output: 0, cacheRead: 0 };
      return `
        <div class="price-row">
          <span class="model-name" title="${esc(key)}">${esc(key)}</span>
          <input type="number" min="0" step="0.0001" data-model="${esc(key)}" data-field="input" value="${esc(r.input)}" title="输入 元/百万token">
          <input type="number" min="0" step="0.0001" data-model="${esc(key)}" data-field="output" value="${esc(r.output)}" title="输出 元/百万token">
          <input type="number" min="0" step="0.0001" data-model="${esc(key)}" data-field="cacheRead" value="${esc(r.cacheRead)}" title="缓存读取 元/百万token">
        </div>`;
    }).join('');
  }

  const logoutBtn = $('logout-btn');
  if (logoutBtn) logoutBtn.classList.toggle('hidden', !c.passwordSet);
}

function renderAll() {
  renderLive();
  renderDsh();
  renderHardware();
  renderSettings();
}

// ------------------------------------------------------------------ network
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    const err = new Error('unauthorized');
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    // Surface the server's message so the UI can explain refusals (for example a
    // protected service) instead of showing a bare status code.
    let detail = null;
    try { detail = await res.json(); } catch {}
    const err = new Error((detail && detail.error) || `${res.status} ${res.statusText}`);
    err.code = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json();
}

// --------------------------------------------------------------- services
async function refreshServices() {
  try {
    const d = await api('/api/services');
    state.services = d.services || [];
    state.neverStop = d.neverStop || [];
    renderServices();
  } catch (e) {
    if (e.code !== 401) console.warn('services refresh failed', e.message);
  }
}

// ------------------------------------------------------- network addresses
async function refreshAddresses() {
  try {
    const d = await api('/api/addresses');
    state.addresses = d;
    renderAddresses();
  } catch (e) {
    if (e.code !== 401) console.warn('addresses refresh failed', e.message);
  }
}

/**
 * Render the list of addresses this server is reachable on.
 *
 * Virtual adapters (Hyper-V, WSL, VPN) are shown but dimmed and labelled, because
 * listing them as equals to the Wi-Fi address sends people to an address their
 * phone cannot open.
 */
function renderAddresses() {
  const box = $('addr-list');
  if (!box) return;
  const d = state.addresses;
  if (!d) {
    box.innerHTML = '<div class="muted">正在读取…</div>';
    return;
  }

  const rows = [];

  // Localhost first: always works on this machine.
  rows.push(`
    <div class="addr-row primary-local">
      <span class="addr-tag">本机</span>
      <span class="addr-value">${esc(d.local)}</span>
      <button class="btn addr-copy" data-copy="${esc(d.local)}">复制</button>
    </div>`);

  // Then the LAN addresses, best first.
  for (const a of d.addresses || []) {
    const isPrimary = d.primary === a.url;
    rows.push(`
      <div class="addr-row ${isPrimary ? 'primary-lan' : ''} ${a.kind === 'virtual' || a.kind === 'vpn' ? 'dim' : ''}">
        <span class="addr-tag">${esc(a.label)}</span>
        <span class="addr-value">${esc(a.url)}</span>
        <span class="addr-adapter">${esc(a.adapter)}</span>
        <button class="btn addr-copy" data-copy="${esc(a.url)}">复制</button>
      </div>`);
  }

  if (!(d.addresses || []).length) {
    rows.push('<div class="muted">没有检测到局域网地址（可能未连接 Wi-Fi 或网线）。</div>');
  }

  box.innerHTML = rows.join('');

  box.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', async () => {
      const text = b.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = '已复制';
      } catch {
        // Clipboard access needs a secure context; fall back to selecting it.
        b.textContent = '请手动复制';
      }
      setTimeout(() => { b.textContent = '复制'; }, 1800);
    });
  });

  const note = $('addr-note');
  if (note) {
    if (!d.listeningOnAll) {
      note.textContent = `当前只监听 ${d.host}，局域网内其他设备无法访问。`
        + '如需手机访问，请把 data/config.json 里的 host 改为 "0.0.0.0" 后重启。';
      note.className = 'note warn-note';
    } else {
      const virtual = (d.addresses || []).filter((a) => a.kind === 'virtual' || a.kind === 'vpn').length;
      note.textContent = virtual
        ? `已监听所有网卡。灰色项是虚拟网卡 / VPN 地址，通常手机无法访问，请用上面高亮的地址。`
        : '已监听所有网卡。手机连同一个 Wi-Fi 即可用上面的地址访问。';
      note.className = 'note';
    }
  }

  renderTunnels(d.tunnels);
}

/**
 * Render the frp tunnel table, or hide the card when no tunnels are configured.
 *
 * Tunnel endpoints live in data/config.json rather than in the source, so a
 * deployment's public addresses are not published with the code.
 */
function renderTunnels(tunnels) {
  const card = $('tunnel-card');
  const body = $('tunnel-table') && $('tunnel-table').querySelector('tbody');
  if (!card || !body) return;

  if (!Array.isArray(tunnels) || !tunnels.length) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  body.innerHTML = tunnels.map((t) => `
    <tr>
      <td>${esc(t.name || '')}</td>
      <td>${esc(t.local || '')}</td>
      <td>${esc(t.remote || '')}</td>
    </tr>`).join('');
}

function renderServices() {
  const box = $('svc-list');
  if (!box) return;
  const list = state.services || [];
  if (!list.length) {
    box.innerHTML = '<div class="muted">正在读取服务状态…</div>';
    return;
  }

  box.innerHTML = list.map((s) => {
    const protectedSvc = (state.neverStop || []).includes(s.key);
    const ports = (s.ports || []).length
      ? s.ports.map((p) => `${p.port}${p.open ? ' ✓' : ' ✗'}`).join('  ')
      : '—';
    // Starting is always allowed; stopping/restarting is hidden for protected
    // services so the UI cannot offer an action the server will refuse.
    const buttons = [
      s.running ? '' : `<button class="btn" data-svc="start" data-key="${esc(s.key)}">启动</button>`,
      s.running && !protectedSvc ? `<button class="btn" data-svc="restart" data-key="${esc(s.key)}">重启</button>` : '',
      s.running && !protectedSvc ? `<button class="btn danger" data-svc="stop" data-key="${esc(s.key)}">停止</button>` : '',
    ].filter(Boolean).join('');

    return `
      <div class="svc-row ${s.running ? 'running' : ''}">
        <span class="svc-dot"></span>
        <span class="svc-name">${esc(s.name)}</span>
        <span class="svc-meta">
          ${s.running ? '运行中' : '已停止'}${s.pid ? ` · PID ${s.pid}` : ''}<br>
          ${esc(s.description || '')}
        </span>
        <span class="svc-ports">${esc(ports)}</span>
        <span class="svc-buttons">${buttons}</span>
        ${protectedSvc ? '<div class="svc-lock">🔒 受保护：本工具不会停止或重启它，只允许你手动关闭</div>' : ''}
      </div>`;
  }).join('');

  const note = $('svc-note');
  if (note) {
    const running = list.filter((s) => s.running).length;
    note.textContent = `${running}/${list.length} 个服务在运行。状态每 5 秒自动刷新。`;
  }

  box.querySelectorAll('[data-svc]').forEach((b) => {
    b.addEventListener('click', () => doServiceAction(b.dataset.svc, b.dataset.key));
  });
}

async function doServiceAction(action, key) {
  const status = $('svc-status');
  if (status) status.textContent = `正在${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}…`;
  try {
    const d = await api('/api/services/action', {
      method: 'POST',
      body: JSON.stringify({ action, service: key || null }),
    });
    state.services = d.services || state.services;
    renderServices();
    if (status) status.textContent = '完成 ✓';
  } catch (e) {
    if (status) status.textContent = e.message;
  }
  setTimeout(() => { const s = $('svc-status'); if (s) s.textContent = ''; }, 4000);
}

// --------------------------------------------------------------- terminal
const term = {
  sessionId: null,
  stream: null,
  enabled: false,
  history: [],
  historyIndex: -1,
  running: false,
};

function termAppend(text, cls) {
  const box = $('term-output');
  if (!box) return;
  const span = document.createElement('span');
  span.className = `term-line ${cls || ''}`;
  span.textContent = text;
  box.appendChild(span);
  // Keep the view pinned to the newest output.
  box.scrollTop = box.scrollHeight;
}

async function initTerminal() {
  const disabledBox = $('term-disabled');
  const ui = $('term-ui');
  if (!disabledBox || !ui) return;

  let info;
  try {
    info = await api('/api/terminal/info');
  } catch {
    disabledBox.classList.remove('hidden');
    ui.classList.add('hidden');
    return;
  }

  term.enabled = !!info.enabled;
  setText('term-state', info.enabled ? '可启动' : '已禁用');

  if (!info.enabled) {
    disabledBox.classList.remove('hidden');
    ui.classList.add('hidden');
    setText('term-disabled-msg', info.reason || '终端已禁用。');
    return;
  }

  disabledBox.classList.add('hidden');
  ui.classList.remove('hidden');
  setText('term-cwd', `工作目录: ${info.cwd || ''}`);
}

async function openTerminal() {
  if (term.sessionId) return;
  termAppend('正在启动 PowerShell 会话…\n', 'system');
  try {
    const d = await api('/api/terminal/open', { method: 'POST' });
    term.sessionId = d.session.id;
    setText('term-state', `已连接 · PID ${d.session.pid || '—'}`);
    attachTerminalStream(term.sessionId);
    $('term-input').disabled = false;
    $('term-send').disabled = false;
    $('term-input').focus();
  } catch (e) {
    termAppend(`启动失败: ${e.message}\n`, 'stderr');
    setText('term-state', '启动失败');
  }
}

function attachTerminalStream(sessionId) {
  if (term.stream) { try { term.stream.close(); } catch {} }
  term.stream = new EventSource(`/api/terminal/stream?session=${encodeURIComponent(sessionId)}`);

  term.stream.addEventListener('output', (e) => {
    try {
      const d = JSON.parse(e.data);
      const cls = d.stream === 'stderr' ? 'stderr'
        : d.stream === 'system' ? 'system'
        : d.stream === 'prompt' ? 'prompt' : '';
      termAppend(d.text, cls);
    } catch {}
  });

  term.stream.addEventListener('done', () => {
    term.running = false;
    $('term-input').disabled = false;
    $('term-send').disabled = false;
    termAppend('✓ 完成\n', 'done');
  });

  term.stream.addEventListener('timeout', () => {
    termAppend('⚠ 命令仍在执行（超过 2 分钟）。可点「中断」结束它。\n', 'timeout');
  });

  term.stream.addEventListener('exit', (e) => {
    try {
      const d = JSON.parse(e.data);
      termAppend(`会话已结束 (退出码 ${d.code})\n`, 'system');
    } catch {}
    term.running = false;
    term.sessionId = null;
    setText('term-state', '会话已结束');
    $('term-input').disabled = true;
    $('term-send').disabled = true;
  });

  term.stream.onerror = () => {
    // The stream ends when the session is destroyed; do not spin on retries.
    if (!term.sessionId) { try { term.stream.close(); } catch {} }
  };
}

async function runTerminalCommand(cmd) {
  if (!term.sessionId) { await openTerminal(); if (!term.sessionId) return; }
  term.running = true;
  $('term-input').disabled = true;
  $('term-send').disabled = true;
  try {
    await api('/api/terminal/run', {
      method: 'POST',
      body: JSON.stringify({ session: term.sessionId, command: cmd }),
    });
  } catch (e) {
    termAppend(`${e.message}\n`, 'stderr');
    term.running = false;
    $('term-input').disabled = false;
    $('term-send').disabled = false;
  }
}

async function closeTerminal() {
  if (!term.sessionId) return;
  try {
    await api('/api/terminal/close', {
      method: 'POST',
      body: JSON.stringify({ session: term.sessionId }),
    });
  } catch {}
  if (term.stream) { try { term.stream.close(); } catch {} term.stream = null; }
  term.sessionId = null;
  term.running = false;
  setText('term-state', '未连接');
  $('term-input').disabled = true;
  $('term-send').disabled = true;
  termAppend('会话已关闭。\n', 'system');
}

// ------------------------------------------------------------------- SSH
//
// Note on session semantics: this machine's OpenSSH cannot provide a usable
// pseudo-terminal over a pipe (verified), so each command runs in its own remote
// shell and shell state does not persist. The UI says so explicitly rather than
// letting the user discover it by losing a variable.
const ssh = {
  sessionId: null,
  stream: null,
  enabled: false,
  running: false,
  hosts: [],
  keys: [],
  history: [],
  historyIndex: -1,
};

function sshAppend(text, cls) {
  const box = $('ssh-output');
  if (!box) return;
  const span = document.createElement('span');
  span.className = `term-line ${cls || ''}`;
  span.textContent = text;
  box.appendChild(span);
  box.scrollTop = box.scrollHeight;
}

async function initSsh() {
  const disabled = $('ssh-disabled');
  const ui = $('ssh-ui');
  if (!disabled || !ui) return;

  let info;
  try {
    info = await api('/api/ssh/hosts');
  } catch {
    disabled.classList.remove('hidden');
    ui.classList.add('hidden');
    return;
  }

  ssh.enabled = !!info.enabled;
  ssh.hosts = info.hosts || [];
  ssh.keys = info.keys || [];

  if (!ssh.enabled) {
    disabled.classList.remove('hidden');
    ui.classList.add('hidden');
    return;
  }

  disabled.classList.add('hidden');
  ui.classList.remove('hidden');

  // Populate the key dropdown with the identities found in ~/.ssh.
  const keySel = $('ssh-key');
  if (keySel) {
    keySel.innerHTML = '<option value="">不使用私钥</option>' +
      ssh.keys.map((k) => `<option value="${esc(k.path)}">${esc(k.name)}</option>`).join('');
  }

  renderSshHosts();
}

function renderSshHosts() {
  const wrap = $('ssh-saved-wrap');
  const box = $('ssh-saved');
  if (!wrap || !box) return;

  if (!ssh.hosts.length) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');

  box.innerHTML = ssh.hosts.map((h) => `
    <div class="ssh-saved-row">
      <span class="ssh-saved-name">${esc(h.name || h.host)}</span>
      <span class="ssh-saved-target">${esc(h.user)}@${esc(h.host)}:${h.port}${h.keyPath ? ' · 私钥' : ''}</span>
      <span class="ssh-saved-buttons">
        <button class="btn primary" data-ssh-use="${esc(h.id)}">连接</button>
        <button class="btn danger" data-ssh-del="${esc(h.id)}">删除</button>
      </span>
    </div>`).join('');

  box.querySelectorAll('[data-ssh-use]').forEach((b) => {
    b.addEventListener('click', () => {
      const h = ssh.hosts.find((x) => x.id === b.dataset.sshUse);
      if (!h) return;
      $('ssh-host').value = h.host || '';
      $('ssh-port').value = h.port || 22;
      $('ssh-user').value = h.user || '';
      if (h.keyPath) $('ssh-key').value = h.keyPath;
      $('ssh-password').value = '';
      connectSsh();
    });
  });

  box.querySelectorAll('[data-ssh-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        const r = await api('/api/ssh/hosts/delete', {
          method: 'POST',
          body: JSON.stringify({ id: b.dataset.sshDel }),
        });
        ssh.hosts = r.hosts || [];
        renderSshHosts();
      } catch (e) {
        setText('ssh-status', e.message);
      }
    });
  });
}

async function connectSsh() {
  const status = $('ssh-status');
  const host = $('ssh-host').value.trim();
  const user = $('ssh-user').value.trim();
  const port = Number($('ssh-port').value) || 22;
  const keyPath = $('ssh-key').value;
  const password = $('ssh-password').value;

  if (!host || !user) {
    if (status) status.textContent = '请填写主机和用户名';
    return;
  }

  if (status) status.textContent = '正在连接…';
  $('ssh-open').disabled = true;

  try {
    const r = await api('/api/ssh/open', {
      method: 'POST',
      body: JSON.stringify({ host, port, user, keyPath, password }),
    });

    ssh.sessionId = r.session.id;
    setText('ssh-state', `已连接 · ${user}@${host}`);
    setText('ssh-target', `${user}@${host}:${port}${keyPath ? ' · 私钥认证' : password ? ' · 密码认证' : ' · agent'}`);
    const prompt = $('ssh-prompt');
    if (prompt) prompt.textContent = `${user}@${host}$`;

    // Show the session, hide the connect form.
    $('ssh-connect-panel').classList.add('hidden');
    $('ssh-saved-wrap').classList.add('hidden');
    $('ssh-session').classList.remove('hidden');

    const out = $('ssh-output');
    if (out) out.innerHTML = '';
    sshAppend(`正在连接 ${user}@${host}:${port} …\n`, 'system');
    if (!r.session.stateful) {
      sshAppend('提示：每条命令在独立 shell 中运行，变量与工作目录不会保留。\n\n', 'system');
    }

    attachSshStream(r.session.id);
    $('ssh-input').disabled = false;
    $('ssh-send').disabled = false;
    $('ssh-input').focus();
    if (status) status.textContent = '';
  } catch (e) {
    if (status) status.textContent = e.message;
    setText('ssh-state', '连接失败');
  }
  $('ssh-open').disabled = false;
}

function attachSshStream(sessionId) {
  if (ssh.stream) { try { ssh.stream.close(); } catch {} }
  ssh.stream = new EventSource(`/api/ssh/stream?session=${encodeURIComponent(sessionId)}`);

  ssh.stream.addEventListener('output', (e) => {
    try {
      const d = JSON.parse(e.data);
      const cls = d.stream === 'stderr' ? 'stderr'
        : d.stream === 'system' ? 'system'
        : d.stream === 'prompt' ? 'prompt' : '';
      sshAppend(d.text, cls);
    } catch {}
  });

  ssh.stream.addEventListener('done', () => {
    ssh.running = false;
    $('ssh-input').disabled = false;
    $('ssh-send').disabled = false;
  });

  ssh.stream.addEventListener('timeout', () => {
    sshAppend('⚠ 命令仍在执行（超过 2 分钟）。\n', 'timeout');
  });

  ssh.stream.addEventListener('exit', (e) => {
    try {
      const d = JSON.parse(e.data);
      sshAppend(`\n连接已结束（退出码 ${d.code}）\n`, 'system');
      if (d.error) sshAppend(`${d.error}\n`, 'stderr');
    } catch {}
    ssh.running = false;
    ssh.sessionId = null;
    setText('ssh-state', '已断开');
    $('ssh-input').disabled = true;
    $('ssh-send').disabled = true;
  });

  ssh.stream.onerror = () => {
    if (!ssh.sessionId) { try { ssh.stream.close(); } catch {} }
  };
}

async function runSshCommand(cmd) {
  if (!ssh.sessionId) return;
  ssh.running = true;
  $('ssh-input').disabled = true;
  $('ssh-send').disabled = true;
  try {
    await api('/api/ssh/run', {
      method: 'POST',
      body: JSON.stringify({ session: ssh.sessionId, command: cmd }),
    });
  } catch (e) {
    sshAppend(`${e.message}\n`, 'stderr');
    ssh.running = false;
    $('ssh-input').disabled = false;
    $('ssh-send').disabled = false;
  }
}

async function closeSsh() {
  if (ssh.sessionId) {
    try {
      await api('/api/ssh/close', {
        method: 'POST',
        body: JSON.stringify({ session: ssh.sessionId }),
      });
    } catch {}
  }
  if (ssh.stream) { try { ssh.stream.close(); } catch {} ssh.stream = null; }
  ssh.sessionId = null;
  ssh.running = false;
  setText('ssh-state', '未连接');
  showSshConnectForm();
}

/** Return to the connection form, hiding the live session. */
function showSshConnectForm() {
  $('ssh-session').classList.add('hidden');
  $('ssh-connect-panel').classList.remove('hidden');
  renderSshHosts();
  $('ssh-input').disabled = true;
  $('ssh-send').disabled = true;
}

function pushSample(s) {
  const b = s.battery || {};
  state.history.push({
    t: s.t,
    cpu: s.cpu ? s.cpu.totalPct : null,
    mem: s.memory ? s.memory.usedPct : null,
    gpu: s.gpu && s.gpu.supported ? s.gpu.maxEnginePct : null,
    power: s.power && s.power.watts !== null && s.power.watts !== undefined
      ? (s.power.mode === 'charging' ? -s.power.watts : s.power.watts)
      : null,
    diskRead: s.diskIo ? s.diskIo.readBytesPerSec : null,
    diskWrite: s.diskIo ? s.diskIo.writeBytesPerSec : null,
    netRx: s.network ? s.network.rxBytesPerSec : null,
    netTx: s.network ? s.network.txBytesPerSec : null,
  });
  if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
}

let stream = null;
let reconnectDelay = 1000;

function connectStream() {
  if (stream) { try { stream.close(); } catch {} }

  stream = new EventSource('/api/stream');

  stream.addEventListener('hello', (e) => {
    try {
      const d = JSON.parse(e.data);
      // The stream's hello carries the full state; the collector's hello event
      // carries the static hardware block.
      if (d.collector) {
        state.hello = d.hello;
        state.config = d.config;
        state.thresholds = d.thresholds;
        state.inventory = d.inventory || state.inventory;
        if (d.sample) state.sample = d.sample;
      } else if (d.static) {
        state.hello = state.hello || {};
        state.hello.static = d.static;
        state.hello.batteryStatic = d.batteryStatic;
        state.hello.capabilities = d.capabilities;
      }
      state.connected = true;
      reconnectDelay = 1000;
      renderAll();
    } catch (err) { console.warn('hello parse failed', err); }
  });

  stream.addEventListener('sample', (e) => {
    try {
      const s = JSON.parse(e.data);
      state.sample = s;
      state.connected = true;
      pushSample(s);
      if (state.view === 'live') renderLive();
      else if (state.view === 'dsh') renderDsh();
    } catch {}
  });

  stream.addEventListener('dsh', (e) => {
    try {
      state.dsh = JSON.parse(e.data);
      if (state.view === 'dsh') renderDsh();
      renderSettings();
    } catch {}
  });

  // Service status arrives over the stream, so the Services tab never polls.
  stream.addEventListener('services', (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.services) {
        state.services = d.services;
        if (state.view === 'services') renderServices();
      }
    } catch {}
  });

  stream.addEventListener('collector-error', (e) => {
    state.connected = false;
    renderAlerts(state.sample);
  });

  stream.onerror = () => {
    state.connected = false;
    renderAlerts(state.sample);
    try { stream.close(); } catch {}
    stream = null;
    // EventSource auto-retries, but a full restart with backoff also recovers
    // from a server that was restarted with a different port or config.
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      connectStream();
    }, reconnectDelay);
  };
}

// -------------------------------------------------------------------- init
function switchView(name, updateHash = true) {
  state.view = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $(`view-${name}`);
  if (el) el.classList.remove('hidden');
  if (name === 'live') {
    for (const c of Object.values(charts)) c.resize();
    redrawCharts();
  }
  if (name === 'hardware') renderHardware();
  if (name === 'settings') renderSettings();
  if (name === 'dsh') renderDsh();
  if (name === 'services') {
    refreshAddresses();
    refreshServices();
  }
  if (name === 'terminal') {
    initTerminal();
    initSsh();
    const inp = $('term-input');
    if (inp && !inp.disabled) inp.focus();
  }
  // Reflect the view in the URL so a tab can be bookmarked or shared.
  if (updateHash) {
    try { history.replaceState(null, '', `#${name}`); } catch {}
  }
}

/** Read the initial view from the URL hash, defaulting to the live view. */
function viewFromHash() {
  const h = (location.hash || '').replace(/^#/, '');
  return ['live', 'dsh', 'services', 'terminal', 'hardware', 'settings'].includes(h) ? h : 'live';
}

function showLogin(show) {
  $('login').classList.toggle('hidden', !show);
  $('app').classList.toggle('hidden', show);
}

async function boot() {
  // Theme preference persists locally.
  const savedTheme = localStorage.getItem('hwm-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  try {
    const st = await api('/api/state');
    state.hello = st.hello;
    state.sample = st.sample;
    state.inventory = st.inventory;
    state.config = st.config;
    state.thresholds = st.thresholds;
    showLogin(false);
    initCharts();
    // Apply the view named in the URL before the first paint.
    switchView(viewFromHash(), false);
    renderAll();
    connectStream();

    // Seed history so charts are not empty on first paint.
    try {
      const s = await api('/api/series');
      state.history = (s.series || []).slice(-MAX_HISTORY);
      redrawCharts();
    } catch {}

    try {
      state.dsh = await api('/api/dsh');
      renderDsh();
      renderSettings();
    } catch {}
  } catch (err) {
    if (err.code === 401) {
      showLogin(true);
      $('login-password').focus();
    } else {
      // Server unreachable: show the login shell with an explanatory message.
      showLogin(true);
      $('login-error').textContent = `无法连接服务器：${err.message}`;
    }
  }
}

// ------------------------------------------------------------------ events
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('login-password').value;
  $('login-error').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      $('login-error').textContent = d.error || '登录失败';
      return;
    }
    $('login-password').value = '';
    await boot();
  } catch (err) {
    $('login-error').textContent = `登录失败：${err.message}`;
  }
});

$$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

window.addEventListener('hashchange', () => switchView(viewFromHash(), false));

$('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = cur;
  localStorage.setItem('hwm-theme', cur);
  for (const c of Object.values(charts)) c.resize();
  redrawCharts();
});

$('logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  location.reload();
});

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const status = $('settings-status');
  status.textContent = '保存中…';
  const patch = {
    refreshMs: Number(f.refreshMs.value),
    historyMinutes: Number(f.historyMinutes.value),
    thresholds: {
      batteryLowPct: Number(f.batteryLowPct.value),
      diskLowFreePct: Number(f.diskLowFreePct.value),
      cpuHighPct: Number(f.cpuHighPct.value),
      memoryHighPct: Number(f.memoryHighPct.value),
    },
  };
  // Only send a password when the user typed one; blank keeps the current value.
  const pw = f.password.value.trim();
  if (pw) patch.password = pw;
  try {
    state.config = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
    status.textContent = '已保存 ✓';
    f.password.value = '';
    renderSettings();
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (err) {
    status.textContent = `保存失败：${err.message}`;
  }
});

$('pricing-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const status = $('pricing-status');
  status.textContent = '保存中…';
  const models = {};
  for (const input of $$('#pricing-rows input[data-model]')) {
    const key = input.dataset.model;
    if (!models[key]) models[key] = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
    models[key][input.dataset.field] = Number(input.value) || 0;
  }
  const patch = {
    pricing: {
      currency: f.currency.value.trim() || 'CNY',
      models,
      defaultRates: {
        input: Number(f['def-input'].value) || 0,
        output: Number(f['def-output'].value) || 0,
        cacheRead: Number(f['def-cacheRead'].value) || 0,
        reasoning: 0,
      },
    },
  };
  try {
    state.config = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
    // Re-pull the DSH report so costs recompute with the new rates.
    state.dsh = await api('/api/dsh');
    status.textContent = '已保存 ✓';
    renderDsh();
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (err) {
    status.textContent = `保存失败：${err.message}`;
  }
});

$('dsh-rescan').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '扫描中…';
  try {
    const r = await api('/api/dsh/rescan', { method: 'POST' });
    state.dsh = r.report;
    renderDsh();
    btn.textContent = `完成 (${r.scanMs}ms)`;
  } catch (err) {
    btn.textContent = '扫描失败';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = '重新扫描'; }, 2000);
});

$('inv-refresh').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '采集中…';
  try {
    state.inventory = await api('/api/hardware/refresh', { method: 'POST' });
    renderHardware();
    btn.textContent = '完成 ✓';
  } catch {
    btn.textContent = '采集失败';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = '重新采集'; }, 2000);
});

// ------------------------------------------------------- service controls
$('svc-refresh').addEventListener('click', () => refreshServices());
$('addr-refresh').addEventListener('click', () => refreshAddresses());

$$('[data-svc-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.svcAction;
    if (action === 'stop' && !confirm('确定要停止全部服务吗？\n\n受保护的服务（DSH）不会被停止。')) return;
    if (action === 'restart' && !confirm('确定要重启全部服务吗？\n\n受保护的服务（DSH）不会被重启。')) return;
    const status = $('svc-status');
    if (status) status.textContent = '执行中…';
    btn.disabled = true;
    try {
      const d = await api('/api/services/action', {
        method: 'POST',
        body: JSON.stringify({ action, service: null }),
      });
      state.services = d.services || state.services;
      renderServices();
      if (status) status.textContent = '完成 ✓';
    } catch (e) {
      if (status) status.textContent = e.message;
    }
    btn.disabled = false;
    setTimeout(() => { const s = $('svc-status'); if (s) s.textContent = ''; }, 5000);
  });
});

// ---------------------------------------------------------- terminal wiring
$('term-open').addEventListener('click', () => openTerminal());
$('term-close').addEventListener('click', () => closeTerminal());
$('term-clear').addEventListener('click', () => {
  const box = $('term-output');
  if (box) box.innerHTML = '';
});
$('term-interrupt').addEventListener('click', async () => {
  if (!term.sessionId) return;
  try {
    await api('/api/terminal/interrupt', {
      method: 'POST',
      body: JSON.stringify({ session: term.sessionId }),
    });
    termAppend('已发送中断，会话已终止。请点「启动终端」重新开始。\n', 'system');
    term.sessionId = null;
    term.running = false;
    $('term-input').disabled = true;
    $('term-send').disabled = true;
    setText('term-state', '已中断');
  } catch (e) {
    termAppend(`中断失败: ${e.message}\n`, 'stderr');
  }
});

$('term-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('term-input');
  const cmd = inp.value;
  if (!cmd.trim()) return;
  inp.value = '';
  term.history.push(cmd);
  if (term.history.length > 200) term.history.shift();
  term.historyIndex = term.history.length;
  await runTerminalCommand(cmd);
});

// Command history navigation with the arrow keys.
$('term-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!term.history.length) return;
    term.historyIndex = Math.max(0, term.historyIndex - 1);
    e.target.value = term.history[term.historyIndex] || '';
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!term.history.length) return;
    term.historyIndex = Math.min(term.history.length, term.historyIndex + 1);
    e.target.value = term.historyIndex >= term.history.length ? '' : (term.history[term.historyIndex] || '');
  }
});

// ------------------------------------------------------------ SSH wiring
$('ssh-open').addEventListener('click', () => connectSsh());
$('ssh-close').addEventListener('click', () => closeSsh());
$('ssh-disconnect-form').addEventListener('click', () => {
  // Keep the session alive but return to the form so another host can be opened.
  showSshConnectForm();
});
$('ssh-clear').addEventListener('click', () => {
  const box = $('ssh-output');
  if (box) box.innerHTML = '';
});
$('ssh-clear-host').addEventListener('click', () => {
  $('ssh-host').value = '';
  $('ssh-port').value = '22';
  $('ssh-user').value = '';
  $('ssh-password').value = '';
  $('ssh-key').value = '';
  setText('ssh-status', '');
});

$('ssh-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('ssh-input');
  const cmd = inp.value;
  if (!cmd.trim()) return;
  inp.value = '';
  ssh.history.push(cmd);
  if (ssh.history.length > 200) ssh.history.shift();
  ssh.historyIndex = ssh.history.length;
  await runSshCommand(cmd);
});

$('ssh-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!ssh.history.length) return;
    ssh.historyIndex = Math.max(0, ssh.historyIndex - 1);
    e.target.value = ssh.history[ssh.historyIndex] || '';
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!ssh.history.length) return;
    ssh.historyIndex = Math.min(ssh.history.length, ssh.historyIndex + 1);
    e.target.value = ssh.historyIndex >= ssh.history.length ? '' : (ssh.history[ssh.historyIndex] || '');
  }
});

// Remember the host when the save checkbox is ticked, right after connecting.
$('ssh-open').addEventListener('click', async () => {
  if (!$('ssh-save').checked) return;
  const host = $('ssh-host').value.trim();
  const user = $('ssh-user').value.trim();
  if (!host || !user) return;
  try {
    const r = await api('/api/ssh/hosts', {
      method: 'POST',
      body: JSON.stringify({
        host: {
          name: `${user}@${host}`,
          host,
          user,
          port: Number($('ssh-port').value) || 22,
          keyPath: $('ssh-key').value,
        },
      }),
    });
    ssh.hosts = r.hosts || [];
    renderSshHosts();
  } catch {}
});

// Clock, and a light re-render of the visible view only.
//
// Service status is deliberately NOT polled on a timer. It arrives over the
// existing SSE stream (the 'services' event), so the browser never has to issue a
// request whose answer the server already knows. Polling it every second
// previously triggered a PowerShell-backed multi-second probe on each tick and
// made the whole page feel frozen.
setInterval(() => {
  setText('clock', new Date().toLocaleTimeString('zh-CN', { hour12: false }));
  if (state.view === 'dsh') renderDsh();
  if (!state.connected) renderAlerts(state.sample);
}, 1000);

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const c of Object.values(charts)) c.resize();
    redrawCharts();
  }, 150);
});

// Warn before leaving when a password is set but unsaved pricing exists is
// unnecessary; instead, surface unpriced models once on first DSH load.
boot();
