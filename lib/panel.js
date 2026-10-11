'use strict';
/**
 * HwMonitor service control panel (TUI).
 *
 * This is a control panel ONLY. It does not itself render the monitoring
 * dashboard: hardware figures are shown either in the browser or, on request, in
 * a native window (see lib/native.js). This screen exists to start, stop,
 * restart and inspect the three services:
 *
 *   1. HwMonitor  - web dashboard            (port 8080)
 *   2. DSH        - DeepSeek Harness         (ports 3080, 3082)
 *   3. FRPC       - the intranet tunnel      (maps both to the internet)
 *
 * Safety: this panel never terminates a process in its own ancestry. It is
 * normally launched from inside a DSH session, so the DSH host is an ancestor;
 * killing it would destroy the session that issued the command. That guard lives
 * in lib/services.js (PROTECTED_PIDS) and is applied on every stop.
 *
 * Keys:
 *   q / Esc  quit          1  status view
 *   a        start all     s  stop all      r  restart all
 *   w        start/stop HwMonitor
 *   d        start/restart/stop DSH
 *   f        start/stop FRPC
 *   p        open a PowerShell window
 *   n        launch the native monitoring window
 *   R        refresh now
 */

const os = require('os');
const { ansi, C, visibleWidth, truncate, pad, fg, Screen, box } = require('./tui/ansi');
const services = require('./services');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Panel {
  constructor() {
    this.screen = new Screen();
    this.running = false;
    this.busy = false;
    this.statusMsg = '';
    this.statusUntil = 0;
    this.state = [];          // last known service statuses
    this.lastRefresh = null;
    this.view = 'services';
    this.timer = null;
  }

  setStatus(msg, ms = 6000) {
    this.statusMsg = msg;
    this.statusUntil = Date.now() + ms;
    this.draw();
  }

  start() {
    this.screen.enter();
    this.running = true;
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch {}
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (k) => this.onKey(k));
    process.stdout.on('resize', () => this.draw());
    process.on('SIGINT', () => this.quit());
    process.on('SIGTERM', () => this.quit());

    this.refresh();
    this.loop();
    this.draw();
  }

  loop() {
    const tick = async () => {
      if (!this.running) return;
      if (!this.busy) { try { await this.refresh(); } catch {} }
      this.timer = setTimeout(tick, 3000);
    };
    tick();
  }

  async refresh() {
    this.state = await services.statusAll();
    this.lastRefresh = Date.now();
    if (this.running) this.draw();
  }

  async guarded(label, fn) {
    if (this.busy) return;
    this.busy = true;
    this.setStatus(`${label}…`, 60000);
    try {
      const results = await fn();
      const parts = [];
      for (const r of [].concat(results)) {
        const name = services.SERVICES[r.key] ? services.SERVICES[r.key].name : r.key;
        if ((r.started !== undefined && r.started) || (r.stopped !== undefined && r.stopped)) {
          parts.push(`${name} ✓`);
        } else if (r.reason === '已在运行' || r.reason === '未在运行') {
          parts.push(`${name} ${r.reason}`);
        } else {
          parts.push(`${name} ${r.reason || '失败'}`);
        }
      }
      this.setStatus(parts.join('   '), 8000);
    } catch (e) {
      this.setStatus(`${label}失败: ${e.message}`, 8000);
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  /** Toggle one service: stop if running, otherwise start. */
  async toggle(key) {
    const svc = services.SERVICES[key];
    const st = await services.status(key);
    if (st.running) {
      return this.guarded(`停止 ${svc.name}`, () => services.stop(key));
    }
    return this.guarded(`启动 ${svc.name}`, () => services.start(key));
  }

  async onKey(key) {
    if (key === 'q' || key === '\u0003' || key === '\u001b') return this.quit();
    if (key === 'R') { await this.refresh(); this.setStatus('已刷新', 2000); return; }
    if (this.busy) return;

    switch (key) {
      case 'a': return this.guarded('启动全部', () => services.startAll());
      case 's': return this.guarded('停止 HwMonitor 与穿透', () => this.stopStoppable());
      case 'r': return this.restartAll();
      case 'w': return this.toggle('hwmonitor');
      case 'd': return this.restartDsh();
      case 'f': return this.toggle('frpc');
      case '1': this.view = 'services'; return this.draw();
      case 'p':
        this.openShell('powershell');
        return this.setStatus('已打开 PowerShell 窗口', 4000);
      case 'n':
        this.launchNative();
        return this.setStatus('已启动原生监控窗口', 5000);
      case 'b':
        this.openBrowser();
        return this.setStatus('已在浏览器中打开（含网页终端与服务控制）', 5000);
      default:
        return;
    }
  }

  /**
   * Restart all services that may be stopped. DSH is excluded because it is
   * policy-protected (see services.NEVER_STOP), so running this from inside a DSH
   * session cannot tear the session down.
   */
  async restartAll() {
    await this.guarded('停止 HwMonitor 与穿透', () => this.stopStoppable());
    await sleep(1500);
    await this.guarded('启动全部', () => services.startAll());
  }

  /**
   * Stop every service except those protected by policy. Returns the results so
   * the caller can report them.
   */
  async stopStoppable() {
    const results = [];
    for (const key of [...services.ORDER].reverse()) {
      if (services.isNeverStop(key)) {
        results.push({
          key,
          stopped: false,
          reason: '受保护，未停止',
          killed: [],
          policyBlocked: true,
        });
        continue;
      }
      results.push(await services.stop(key));
    }
    return results;
  }

  /** Show DSH status, and offer a restart when that is permitted. */
  async showDsh() {
    const st = await services.status('dsh');
    const ports = st.ports.map((p) => `${p.port}${p.open ? '✓' : '✗'}`).join(' ');
    const blocked = services.isNeverStop('dsh');
    this.setStatus(
      st.running
        ? `DSH 运行中 (PID ${st.pid}) 端口 ${ports}` + (blocked ? ' — 受保护，只能手动关闭' : ' — 按 d 可重启（会中断当前会话）')
        : 'DSH 未运行。按 a 可启动全部服务（含 DSH）。',
      9000
    );
  }

  /**
   * Restart DSH.
   *
   * Whether this is allowed is governed by safety.neverStop in config.json. When
   * DSH is protected the panel refuses; when it is not, the restart proceeds but
   * is confirmed first, because terminating DSH also terminates the session that
   * this panel may be running inside.
   */
  async restartDsh() {
    const st = await services.status('dsh');
    if (services.isNeverStop('dsh')) {
      this.setStatus('DSH 受保护，本工具不会停止或重启它。如需开启，请修改 data/config.json 的 safety.neverStop。', 9000);
      return;
    }
    if (st.running && !this.confirmedDshRestart) {
      // A restart kills the DSH host, which may be hosting this very panel, so it
      // is never done on a single keystroke.
      this.confirmedDshRestart = true;
      this.setStatus('⚠ 再次按 d 确认重启 DSH。这会中断所有 DSH 会话（包括正在运行的本控制台）。', 12000);
      return;
    }
    this.confirmedDshRestart = false;
    if (st.running) {
      await this.guarded('停止 DSH', () => services.stop('dsh'));
      await sleep(1500);
    }
    await this.guarded('启动 DSH', () => services.start('dsh'));
  }

  /** Open an interactive shell window in the project directory. */
  openShell(prog) {
    const { spawn } = require('child_process');
    // start /WAIT-less: a new window is opened and this call returns immediately.
    spawn('cmd.exe', ['/c', 'start', '', prog], {
      cwd: require('path').join(__dirname, '..'),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref();
  }

  /** Launch the native monitoring window. */
  launchNative() {
    const { spawn } = require('child_process');
    const root = require('path').join(__dirname, '..');
    // Deliberately NOT detached: a detached window process is torn down together
    // with its launcher. Keeping it attached means the window lives as long as
    // this panel, which is what makes it stable.
    spawn(process.execPath, [require('path').join(root, 'hwm.js'), 'native'], {
      cwd: root,
      stdio: 'ignore',
      windowsHide: false,
    });
  }

  /** Open the web dashboard (which also hosts the terminal and service controls). */
  openBrowser() {
    const { spawn } = require('child_process');
    const fs = require('fs');
    let port = 8080;
    try {
      const cfg = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'data', 'config.json'), 'utf8'));
      if (cfg && cfg.port) port = cfg.port;
    } catch {}
    spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}/`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }

  quit() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    this.screen.exit();
    process.exit(0);
  }

  /** One row per service, with state, pid, ports and hint. */
  serviceLines(width) {
    const inner = width - 4;
    const lines = [];
    const nameW = 11;
    const pidW = 8;
    const portW = 18;

    lines.push(
      `${C.head}${C.bold}${pad('服务', nameW)}${pad('状态', 12)}${pad('PID', pidW, 'right')}  ${pad('端口', portW)}${C.reset}`
    );

    for (const s of this.state) {
      const running = s.running;
      const dot = running ? `${C.accent}●${C.reset}` : `${C.danger}○${C.reset}`;
      const stateTxt = running ? `${C.accent}${C.bold}运行中${C.reset}` : `${C.danger}已停止${C.reset}`;
      // Two independent protections are surfaced: the policy guard (service is
      // never stopped by this tooling) and the ancestry guard (process hosts the
      // current session).
      const policyBlocked = services.isNeverStop(s.key);
      const ancestorBlocked = s.pid !== null && services.isProtected(s.pid);
      const portsTxt = s.ports.length
        ? s.ports.map((p) =>
            `${p.open ? C.accent + '●' + C.reset : C.faint + '○' + C.reset}` +
            `${C.dimText}${p.port}${C.reset}`).join(' ')
        : `${C.faint}—${C.reset}`;
      const pidTxt = s.pid === null ? '—' : String(s.pid) + ((policyBlocked || ancestorBlocked) ? `${C.warn}*${C.reset}` : '');

      lines.push(
        `${dot} ${C.text}${C.bold}${pad(s.name, nameW - 2)}${C.reset}` +
        `${pad(stateTxt, 12)}` +
        `${C.dimText}${pad(pidTxt, pidW, 'right')}${C.reset}  ` +
        `${pad(portsTxt, portW)}`
      );
      lines.push(`${C.faint}  ${truncate(s.description || '', inner - 4)}${C.reset}`);
      if (policyBlocked) {
        lines.push(`${C.warn}  * 受保护：本工具不会停止它（只允许手动关闭）${C.reset}`);
      } else if (ancestorBlocked) {
        lines.push(`${C.warn}  * 该进程承载当前会话，不会被停止${C.reset}`);
      } else if (s.detail) {
        lines.push(`${C.faint}  ${truncate(s.detail, inner - 4)}${C.reset}`);
      }
      lines.push('');
    }
    return lines;
  }

  /** Tunnel mapping info, read from configuration (empty when unconfigured). */
  tunnelLines() {
    let tunnels = [];
    try {
      const cfgPath = require('path').join(__dirname, '..', 'data', 'config.json');
      const cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
      if (Array.isArray(cfg.tunnels)) tunnels = cfg.tunnels;
    } catch {}

    if (!tunnels.length) {
      return [`  ${C.faint}未配置内网穿透映射（可在 data/config.json 的 tunnels 中添加）${C.reset}`];
    }

    return tunnels.map((t) =>
      `  ${C.dimText}${pad(String(t.name || ''), 11)}${C.reset}${C.text}${pad(String(t.local || ''), 20)}${C.reset}` +
      `${C.faint}→${C.reset} ${C.text}${t.remote || ''}${C.reset}`
    );
  }

  helpLines() {
    const dshHint = services.isNeverStop('dsh') ? 'DSH 状态(受保护)' : 'DSH 启/重启';
    return [
      `  ${C.text}a${C.reset} ${C.dimText}全部启动${C.reset}    ${C.text}s${C.reset} ${C.dimText}停止(不含受保护)${C.reset}  ${C.text}r${C.reset} ${C.dimText}重启(不含受保护)${C.reset}  ${C.text}R${C.reset} ${C.dimText}刷新${C.reset}`,
      `  ${C.text}w${C.reset} ${C.dimText}HwMonitor${C.reset}   ${C.text}f${C.reset} ${C.dimText}穿透开关${C.reset}      ${C.text}d${C.reset} ${C.dimText}${dshHint}${C.reset}`,
      `  ${C.text}n${C.reset} ${C.dimText}原生监控窗口${C.reset}  ${C.text}b${C.reset} ${C.dimText}打开网页(含终端)${C.reset}  ${C.text}p${C.reset} ${C.dimText}打开 PowerShell${C.reset}  ${C.text}q${C.reset} ${C.dimText}退出${C.reset}`,
    ];
  }

  draw() {
    if (!this.running) return;
    this.screen.resize();
    const W = this.screen.width;
    const H = this.screen.height;
    const lines = [];

    // header
    const clock = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const title = `${C.accent2}${C.bold} HwMonitor 服务控制台 ${C.reset}`;
    const right = this.busy
      ? `${C.warn}● 操作中…${C.reset}`
      : `${C.accent}● 就绪${C.reset}` + `  ${C.dimText}${clock}${C.reset}`;
    const gap = Math.max(1, W - visibleWidth(title) - visibleWidth(right) - 2);
    lines.push(title + ' '.repeat(gap) + right);
    lines.push('');

    const body = [
      ...box('服务', this.serviceLines(W), W),
      '',
      ...box('内网穿透映射', this.tunnelLines(), W),
    ];

    // Reserve: header(2) + help(3) + status(2)
    const bodyH = Math.max(6, H - 9);
    for (let i = 0; i < bodyH; i++) lines.push(body[i] === undefined ? '' : body[i]);

    for (const l of this.helpLines()) lines.push(l);

    if (this.statusMsg && Date.now() < this.statusUntil) {
      lines.push(`${C.warn}${truncate(this.statusMsg, W)}${C.reset}`);
    } else {
      const host = os.hostname();
      lines.push(`${C.faint}主机 ${host}  ·  每 3 秒自动刷新${C.reset}`);
    }

    this.screen.render(lines);
  }
}

module.exports = { Panel };

if (require.main === module) {
  new Panel().start();
}
