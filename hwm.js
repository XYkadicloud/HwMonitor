'use strict';
/**
 * HwMonitor control CLI.
 *
 * Single entry point for starting, stopping and inspecting the three services
 * (HwMonitor, DSH, FRPC). The .bat launchers and the TUI both call into this, so
 * the start/stop logic exists in exactly one place.
 *
 * Usage:
 *   node hwm.js tui             launch the terminal dashboard
 *   node hwm.js start [service] start all services, or one of hwmonitor|dsh|frpc
 *   node hwm.js stop  [service] stop all services, or one
 *   node hwm.js restart [service]
 *   node hwm.js status          print a one-shot status table
 *   node hwm.js serve           run the HwMonitor web server in the foreground
 *   node hwm.js help
 *
 * Exit codes: 0 success, 1 failure (so the .bat files can report accurately).
 */

const services = require('./lib/services');
const labels = require('./lib/labels');

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'help').toLowerCase();
const target = argv[1] ? argv[1].toLowerCase() : null;

// ANSI helpers. Colour is disabled when stdout is not a terminal so redirected
// output stays clean.
const useColor = process.stdout.isTTY;
const C = {
  reset: useColor ? '\u001b[0m' : '',
  bold: useColor ? '\u001b[1m' : '',
  dim: useColor ? '\u001b[90m' : '',
  green: useColor ? '\u001b[32m' : '',
  red: useColor ? '\u001b[31m' : '',
  yellow: useColor ? '\u001b[33m' : '',
  blue: useColor ? '\u001b[36m' : '',
};

function line(text = '') { process.stdout.write(text + '\n'); }

/** Resolve a service key from a user-supplied name. */
function resolveKey(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  const aliases = {
    hw: 'hwmonitor', hwmonitor: 'hwmonitor', monitor: 'hwmonitor', web: 'hwmonitor',
    dsh: 'dsh', harness: 'dsh',
    frpc: 'frpc', frp: 'frpc', tunnel: 'frpc', '穿透': 'frpc',
  };
  return aliases[n] || (services.SERVICES[n] ? n : null);
}

function fmtPorts(s) {
  if (!s.ports.length) return '—';
  return s.ports.map((p) => `${p.port}${p.open ? '✓' : '✗'}`).join(' ');
}

async function printStatus() {
  const all = await services.statusAll();
  line();
  line(`  ${C.bold}服务状态${C.reset}`);
  line(`  ${C.dim}${'─'.repeat(64)}${C.reset}`);
  line(`  ${C.dim}${'服务'.padEnd(12)}${'状态'.padEnd(10)}${'PID'.padStart(8)}   ${'端口'}${C.reset}`);
  for (const s of all) {
    const state = s.running
      ? `${C.green}${C.bold}运行中${C.reset}`
      : `${C.red}已停止${C.reset}`;
    // Pad the raw text, not the coloured string, so columns line up.
    const statePad = s.running ? '运行中' : '已停止';
    line(
      `  ${C.bold}${s.name.padEnd(12)}${C.reset}` +
      `${state}${' '.repeat(Math.max(0, 10 - statePad.length * 2))}` +
      `${C.dim}${String(s.pid === null ? '—' : s.pid).padStart(8)}${C.reset}   ` +
      `${fmtPorts(s)}`
    );
    if (s.description) line(`  ${C.dim}  ${s.description}${C.reset}`);
    if (s.detail) line(`  ${C.dim}  ${s.detail}${C.reset}`);
  }
  line();
  const running = all.filter((s) => s.running).length;
  line(`  ${running}/${all.length} 个服务在运行`);
  line();
  return running;
}

async function doStart(key) {
  if (key) {
    const svc = services.SERVICES[key];
    line(`  正在启动 ${svc.name}…`);
    const r = await services.start(key);
    if (r.started) {
      line(`  ${C.green}✓ ${svc.name} 已启动${C.reset}${r.pid ? ` (PID ${r.pid})` : ''}`);
      return true;
    }
    line(`  ${C.red}✗ ${svc.name} 启动失败: ${r.reason}${C.reset}`);
    return false;
  }

  line();
  line(`  ${C.bold}正在启动全部服务…${C.reset}`);
  line(`  ${C.dim}${'─'.repeat(64)}${C.reset}`);
  const results = await services.startAll();
  let allOk = true;
  for (const r of results) {
    const svc = services.SERVICES[r.key];
    if (r.started) {
      line(`  ${C.green}✓${C.reset} ${svc.name.padEnd(12)} 已启动${r.pid ? ` (PID ${r.pid})` : ''}`);
    } else if (r.reason === '已在运行') {
      line(`  ${C.blue}•${C.reset} ${svc.name.padEnd(12)} 已在运行${r.pid ? ` (PID ${r.pid})` : ''}`);
    } else {
      line(`  ${C.red}✗${C.reset} ${svc.name.padEnd(12)} ${r.reason}`);
      allOk = false;
    }
  }
  line();
  return allOk;
}

async function doStop(key) {
  if (key) {
    const svc = services.SERVICES[key];
    line(`  正在停止 ${svc.name}…`);
    const r = await services.stop(key);
    if (r.stopped) {
      line(`  ${C.green}✓ ${svc.name} 已停止${C.reset}${r.killed.length ? ` (PID ${r.killed.join(', ')})` : ''}`);
      return true;
    }
    line(`  ${C.yellow}• ${svc.name}: ${r.reason}${C.reset}`);
    return false;
  }

  line();
  line(`  ${C.bold}正在停止全部服务…${C.reset}`);
  line(`  ${C.dim}${'─'.repeat(64)}${C.reset}`);
  const results = await services.stopAll();
  for (const r of results) {
    const svc = services.SERVICES[r.key];
    if (r.stopped) {
      line(`  ${C.green}✓${C.reset} ${svc.name.padEnd(12)} 已停止${r.killed.length ? ` (PID ${r.killed.join(', ')})` : ''}`);
    } else if (r.policyBlocked) {
      line(`  ${C.yellow}🛡${C.reset} ${svc.name.padEnd(12)} 受保护，未停止（只允许手动关闭）`);
    } else if (r.reason === '未在运行') {
      line(`  ${C.blue}•${C.reset} ${svc.name.padEnd(12)} 未在运行`);
    } else {
      line(`  ${C.yellow}•${C.reset} ${svc.name.padEnd(12)} ${r.reason}`);
    }
  }
  line();
  return true;
}

function printHelp() {
  line();
  line(`  ${C.bold}HwMonitor 控制台${C.reset}`);
  line(`  ${C.dim}${'─'.repeat(64)}${C.reset}`);
  line(`  ${C.bold}node hwm.js tui${C.reset}              服务控制台（终端界面）`);
  line(`  ${C.bold}node hwm.js native${C.reset}           原生监控窗口（无需浏览器）`);
  line(`  ${C.bold}node hwm.js start${C.reset}            启动全部服务`);
  line(`  ${C.bold}node hwm.js stop${C.reset}             停止服务（DSH 受保护，会跳过）`);
  line(`  ${C.bold}node hwm.js restart${C.reset}          重启服务（DSH 受保护，会跳过）`);
  line(`  ${C.bold}node hwm.js status${C.reset}           查看服务状态`);
  line(`  ${C.bold}node hwm.js serve${C.reset}            前台运行网页服务`);
  line();
  line(`  ${C.bold}DSH 单独控制${C.reset}`);
  line(`  ${C.bold}node hwm.js dsh${C.reset}              查看 DSH 状态`);
  line(`  ${C.bold}node hwm.js dsh start${C.reset}        启动 DSH（若未运行）`);
  line(`  ${C.bold}node hwm.js dsh stop${C.reset}         停止 DSH`);
  line(`  ${C.bold}node hwm.js dsh restart${C.reset}      重启 DSH（承载本会话时会拒绝）`);
  line();
  line(`  ${C.bold}其他${C.reset}`);
  line(`  ${C.bold}node hwm.js ps${C.reset}               打开 PowerShell 窗口（项目目录）`);
  line(`  ${C.bold}node hwm.js native${C.reset}           打开原生监控窗口`);
  line();
  line(`  ${C.dim}服务名: hwmonitor | dsh | frpc${C.reset}`);
  line();
  line(`  ${C.yellow}安全策略: DSH 永不被本工具停止或重启，只能由你手动关闭。${C.reset}`);
  line(`  ${C.dim}  原因: 远程操作时若 DSH 被关闭，需要有人在电脑前才能重新打开。${C.reset}`);
  line(`  ${C.dim}  如需解除，编辑 data/config.json 的 safety.neverStop 后重启服务。${C.reset}`);
  line();
}

(async () => {
  try {
    switch (cmd) {
      case 'tui':
      case 'panel': {
        // Control panel only: start/stop/restart services. The monitoring
        // display lives in the browser or the native window ('node hwm.js native').
        const { Panel } = require('./lib/panel');
        new Panel().start();
        return;
      }

      case 'start': {
        const key = target ? resolveKey(target) : null;
        if (target && !key) {
          line(`  ${C.red}未知服务: ${target}${C.reset}`);
          printHelp();
          process.exit(1);
        }
        const ok = await doStart(key);
        if (!key) await printStatus();
        process.exit(ok ? 0 : 1);
      }

      case 'stop': {
        const key = target ? resolveKey(target) : null;
        if (target && !key) {
          line(`  ${C.red}未知服务: ${target}${C.reset}`);
          printHelp();
          process.exit(1);
        }
        await doStop(key);
        if (!key) await printStatus();
        process.exit(0);
      }

      case 'restart': {
        const key = target ? resolveKey(target) : null;
        if (target && !key) {
          line(`  ${C.red}未知服务: ${target}${C.reset}`);
          process.exit(1);
        }
        await doStop(key);
        await new Promise((r) => setTimeout(r, 1500));
        const ok = await doStart(key);
        process.exit(ok ? 0 : 1);
      }

      case 'status': {
        const running = await printStatus();
        process.exit(running > 0 ? 0 : 0);
      }

      case 'dsh': {
        // Dedicated DSH control.
        //
        // Whether DSH may be stopped or restarted is governed by
        // safety.neverStop in data/config.json. When protection is enabled the
        // command refuses; when it is disabled the restart proceeds with an
        // explicit warning, because terminating DSH also terminates the session
        // the command may be running inside.
        const sub = (target || 'status').toLowerCase();
        if (sub === 'status') {
          const s = await services.status('dsh');
          line();
          line(`  DSH: ${s.running ? `${C.green}运行中${C.reset}` : `${C.red}已停止${C.reset}`}` +
            `${s.pid ? ` (PID ${s.pid})` : ''}  ${fmtPorts(s)}`);
          line(services.isNeverStop('dsh')
            ? `  ${C.yellow}受保护：本工具不会停止或重启 DSH${C.reset}`
            : `  ${C.dim}可停止/重启（safety.neverStop 为空）${C.reset}`);
          line();
          process.exit(s.running ? 0 : 1);
        }
        if (sub === 'start') {
          const r = await services.start('dsh');
          line(r.started
            ? `  ${C.green}✓ DSH 已启动${C.reset}${r.pid ? ` (PID ${r.pid})` : ''}`
            : `  ${C.dim}• DSH ${r.reason}${C.reset}`);
          process.exit(r.started ? 0 : 1);
        }
        if (sub === 'stop' || sub === 'restart') {
          if (services.isNeverStop('dsh')) {
            line();
            line(`  ${C.yellow}已拒绝：DSH 当前受保护（data/config.json 的 safety.neverStop）。${C.reset}`);
            line(`  ${C.dim}如需开启停止/重启，把 safety.neverStop 置为 [] 后重试。${C.reset}`);
            line();
            process.exit(1);
          }
          if (sub === 'stop') {
            const r = await services.stop('dsh');
            line(r.stopped ? `  ${C.green}✓ DSH 已停止${C.reset}` : `  ${C.dim}• DSH ${r.reason}${C.reset}`);
            process.exit(r.stopped ? 0 : 1);
          }
          // Restart. This terminates the DSH host, which may be hosting the very
          // session this command was issued from, so it is stated plainly.
          line(`  ${C.yellow}正在重启 DSH —— 所有 DSH 会话（包括当前这个）都会被中断。${C.reset}`);
          await services.stop('dsh');
          await new Promise((r) => setTimeout(r, 2000));
          const r = await services.start('dsh');
          line(r.started
            ? `  ${C.green}✓ DSH 已重启${C.reset}${r.pid ? ` (PID ${r.pid})` : ''}`
            : `  ${C.red}✗ DSH 重启失败: ${r.reason}${C.reset}`);
          process.exit(r.started ? 0 : 1);
        }
        line(`  ${C.red}未知子命令: ${sub}${C.reset}`);
        line(`  ${C.dim}用法: node hwm.js dsh <status|start|stop|restart>${C.reset}`);
        process.exit(1);
      }

      case 'ps':
      case 'powershell': {
        // Open an interactive PowerShell window in this project directory.
        const { spawn } = require('child_process');
        const cwd = __dirname;
        spawn('cmd.exe', ['/c', 'start', '', 'powershell', '-NoExit', '-Command',
          `Set-Location '${cwd}'; Write-Host 'HwMonitor 项目目录' -ForegroundColor Cyan`],
          { cwd, detached: true, stdio: 'ignore' }).unref();
        line(`  ${C.green}已打开 PowerShell 窗口${C.reset}`);
        line(`  ${C.dim}目录: ${cwd}${C.reset}`);
        line(`  ${C.dim}可用: node hwm.js status | start | stop | dsh restart${C.reset}`);
        process.exit(0);
      }

      case 'native':
      case 'window': {
        // The native WinForms window was archived (see archive/): the browser is
        // the interface now. This command is kept as a pointer so an old shortcut
        // or muscle memory produces a useful message rather than a module error.
        line(`  ${C.yellow}原生窗口已归档，不再维护。${C.reset}`);
        line(`  ${C.dim}请使用网页界面: node hwm.js open-web${C.reset}`);
        line(`  ${C.dim}归档文件: archive\\native-window.ps1, archive\\native.js${C.reset}`);
        process.exit(0);
      }

      case 'open-web': {
        // Open the web UI, starting the server first if it is not already up.
        const configMod = require('./lib/config');
        let port = 8080;
        try {
          const raw = require('fs').readFileSync(
            require('path').join(configMod.ROOT, 'data', 'config.json'), 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed.port) port = parsed.port;
        } catch {}

        const net = require('net');
        const isOpen = await new Promise((resolve) => {
          const s = net.connect(port, '127.0.0.1');
          s.on('connect', () => { s.destroy(); resolve(true); });
          s.on('error', () => resolve(false));
          setTimeout(() => { s.destroy(); resolve(false); }, 1500);
        });

        if (!isOpen) {
          line(`  ${C.dim}服务未运行，正在启动…${C.reset}`);
          const r = await services.start('hwmonitor');
          line(r.started
            ? `  ${C.green}✓ 服务已启动${C.reset}`
            : `  ${C.yellow}• ${r.reason}${C.reset}`);
        }

        const { spawn } = require('child_process');
        spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}/`], {
          detached: true, stdio: 'ignore',
        }).unref();
        line(`  ${C.green}已在浏览器中打开${C.reset} http://127.0.0.1:${port}/`);
        process.exit(0);
      }

      case 'serve': {
        require('./server.js');
        return;
      }

      case 'help':
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);

      default:
        line(`  ${C.red}未知命令: ${cmd}${C.reset}`);
        printHelp();
        process.exit(1);
    }
  } catch (e) {
    line(`  ${C.red}错误: ${e && e.stack ? e.stack : e}${C.reset}`);
    process.exit(1);
  }
})();
