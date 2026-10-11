'use strict';
/**
 * Launcher messages for the .bat entry points.
 *
 * Why this is JavaScript and not PowerShell: Windows PowerShell 5.1 decodes .ps1
 * file contents with the system ANSI codepage unless the file carries a UTF-8
 * BOM, so Chinese text in a .ps1 is corrupted at parse time whenever the BOM is
 * missing (and a BOM is easy to lose on any future re-save). Node reads source
 * files as UTF-8 unconditionally, so the text below is always intact. The .bat
 * launcher stays pure ASCII because cmd.exe mis-parses non-ASCII bytes in a
 * batch file; it calls this script for all user-facing output.
 *
 * Usage:
 *   node lib/launcher-msg.js <ok|fail|port-busy|no-node|cleanup> [key=value ...]
 *
 * Recognised key=value pairs: port, lanip, detail
 */

const args = process.argv.slice(2);
const status = args[0] || 'unknown';

const opts = {};
for (const a of args.slice(1)) {
  const i = a.indexOf('=');
  if (i > 0) opts[a.slice(0, i)] = a.slice(i + 1);
}

const port = opts.port || '8080';
const lanip = opts.lanip || '';
const detail = opts.detail || '';

// ANSI colours; Windows 10 consoles support these when the terminal enables
// virtual terminal processing. If unsupported they degrade to plain text.
const C = {
  reset: '\u001b[0m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  dim: '\u001b[90m',
};

/** Colour only when writing to a real terminal. */
const useColor = process.stdout.isTTY;

function line(text = '', color = '') {
  if (useColor && color && C[color]) {
    process.stdout.write(`${C[color]}${text}${C.reset}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

switch (status) {
  case 'ok':
    line();
    line('  HwMonitor 启动成功。', 'green');
    line();
    line(`  本机:   http://127.0.0.1:${port}/`);
    if (lanip) line(`  局域网: http://${lanip}:${port}/`);
    line();
    line('  未自动打开浏览器（按你的要求）。', 'dim');
    line('  停止服务: 运行 停止监控.bat', 'dim');
    line();
    break;

  case 'fail':
    line();
    line(`  [错误] 启动超时，服务未能在 ${port} 端口监听。`, 'red');
    line();
    line('  请查看日志:');
    line('    Get-Content data\\server.log -Encoding UTF8 -Tail 30');
    line();
    break;

  case 'port-busy':
    line();
    line(`  [错误] 端口 ${port} 已被其他程序占用（PID ${detail}）。`, 'red');
    line();
    line('  请修改 data\\config.json 中的 port 后重试。');
    line();
    break;

  case 'no-node':
    line();
    line('  [错误] 没有找到 Node.js。', 'red');
    line();
    line('  请先安装: https://nodejs.org/');
    line();
    break;

  case 'cleanup':
    if (detail === 'stale-record-removed') {
      line('  清理了上次运行的陈旧记录。', 'dim');
    } else if (detail.startsWith('pid-reused-')) {
      const other = detail.slice('pid-reused-'.length);
      line(`  [注意] 记录中的 PID ${other} 已被其他程序占用，未做处理。`, 'yellow');
    } else {
      line('  已停止上次崩溃遗留的进程。', 'dim');
    }
    break;

  case 'stopped':
    line();
    line('  HwMonitor 已停止。', 'green');
    line();
    break;

  case 'not-running':
    line();
    line('  HwMonitor 当前没有在运行。', 'yellow');
    line();
    break;

  default:
    line(`  (未知状态: ${status})`);
}

// Node keeps the process alive only while there is pending work; nothing here
// holds the loop open, so it exits on its own.
