'use strict';
/**
 * Hardware collector: supervises the PowerShell sampler and exposes its latest
 * reading plus a short in-memory history.
 *
 * The sampler is a long-lived child process. That is deliberate: building the
 * PerformanceCounter objects costs ~1.6s on this class of machine, so paying it
 * once at startup and then reusing them per sample is the difference between a
 * usable monitor and one that pegs the CPU.
 */

const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const PS_SCRIPT = path.join(__dirname, '..', 'ps', 'collector.ps1');

class Collector extends EventEmitter {
  /**
   * @param {{intervalMs?: number, historyMinutes?: number}} opts
   */
  constructor(opts = {}) {
    super();
    this.intervalMs = opts.intervalMs || 2000;
    this.historyMinutes = opts.historyMinutes || 15;
    this.proc = null;
    this.hello = null;
    this.latest = null;
    /** @type {Array<object>} trimmed ring of samples */
    this.history = [];
    this.lastError = null;
    this.startedAt = null;
    this.restarts = 0;
    this.stopping = false;
    this.backoffMs = 1000;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.sampleCount = 0;
    this.lastSampleAt = null;
  }

  start() {
    if (this.proc) return;
    this.stopping = false;
    this.startedAt = Date.now();

    // -NoProfile avoids the user's profile slowing startup; ExecutionPolicy
    // Bypass is required because the script is unsigned.
    //
    // spawn() can throw synchronously when the environment forbids it (observed:
    // `spawn EROFS` when the server inherits a restricted sandbox from whatever
    // launched it). That exception previously escaped start() and killed the whole
    // web server, which is why the dashboard would load and then die a few seconds
    // later, leaving an unstyled page. It is caught here and turned into a
    // retryable error instead.
    try {
      this.proc = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, HWM_INTERVAL_MS: String(this.intervalMs) },
        }
      );
    } catch (e) {
      this.proc = null;
      this.lastError = `无法启动采样器: ${e.message}`;
      this.emit('error', this.lastError);
      this.scheduleRestart();
      return;
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onStdout(chunk));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.stderrBuf += chunk;
      if (this.stderrBuf.length > 8192) this.stderrBuf = this.stderrBuf.slice(-8192);
    });

    this.proc.on('error', (err) => {
      this.lastError = `spawn failed: ${err.message}`;
      this.emit('error', this.lastError);
      this.scheduleRestart();
    });

    this.proc.on('close', (code) => {
      const wasStopping = this.stopping;
      this.proc = null;
      if (!wasStopping) {
        this.lastError = `collector exited (code ${code})`;
        if (this.stderrBuf.trim()) {
          this.lastError += `: ${this.stderrBuf.trim().split('\n').slice(-3).join(' | ')}`;
        }
        this.emit('error', this.lastError);
        this.scheduleRestart();
      }
    });
  }

  onStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
    // Guard against a runaway line if the child misbehaves.
    if (this.stdoutBuf.length > 1 << 20) this.stdoutBuf = '';
  }

  handleLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // partial or non-JSON output; ignore
    }

    if (obj.kind === 'hello') {
      this.hello = obj;
      this.backoffMs = 1000;
      this.emit('hello', obj);
      return;
    }

    if (obj.kind === 'sample') {
      this.sampleCount++;
      this.lastSampleAt = Date.now();
      this.latest = obj;
      this.history.push(obj);

      // Bound history by both count and the configured time window. At a 2s
      // cadence, 15 minutes is 450 samples; the cap keeps memory flat if the
      // interval is configured very low.
      const maxAgeMs = this.historyMinutes * 60 * 1000;
      const cutoff = Date.now() - maxAgeMs;
      while (this.history.length > 0 && this.history[0].t < cutoff) this.history.shift();
      if (this.history.length > 5000) this.history.splice(0, this.history.length - 5000);

      this.emit('sample', obj);
    }
  }

  scheduleRestart() {
    if (this.stopping) return;
    this.restarts++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    this.emit('restarting', { delay, restarts: this.restarts });
    setTimeout(() => {
      if (!this.stopping) this.start();
    }, delay);
  }

  stop() {
    this.stopping = true;
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }

  /** True when samples are arriving roughly on schedule. */
  isHealthy() {
    if (!this.latest || !this.lastSampleAt) return false;
    return Date.now() - this.lastSampleAt < this.intervalMs * 5 + 5000;
  }

  status() {
    return {
      running: !!this.proc,
      healthy: this.isHealthy(),
      intervalMs: this.intervalMs,
      sampleCount: this.sampleCount,
      lastSampleAt: this.lastSampleAt,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastError: this.lastError,
      collectorPid: this.hello ? this.hello.pid : null,
      selfCostMs: this.latest ? this.latest.selfCostMs : null,
      historyLength: this.history.length,
    };
  }

  /** History as a compact series for charting. */
  series() {
    return this.history.map((s) => ({
      t: s.t,
      cpu: s.cpu ? s.cpu.totalPct : null,
      mem: s.memory ? s.memory.usedPct : null,
      gpu: s.gpu ? s.gpu.maxEnginePct : null,
      // Signed watts: positive while discharging, negative while charging, so a
      // single series can show both directions on the history chart.
      power: s.power && s.power.watts !== null && s.power.watts !== undefined
        ? (s.power.mode === 'charging' ? -s.power.watts : s.power.watts)
        : null,
      powerMode: s.power ? s.power.mode : null,
      battery: s.battery ? s.battery.percent : null,
      diskBusy: s.diskIo ? s.diskIo.busyPct : null,
      netRx: s.network ? s.network.rxBytesPerSec : null,
      netTx: s.network ? s.network.txBytesPerSec : null,
      diskRead: s.diskIo ? s.diskIo.readBytesPerSec : null,
      diskWrite: s.diskIo ? s.diskIo.writeBytesPerSec : null,
    }));
  }
}

module.exports = { Collector, PS_SCRIPT };
