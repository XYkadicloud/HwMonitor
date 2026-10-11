'use strict';
/**
 * Run the HwMonitor server under Windows Task Scheduler.
 *
 * Why this exists
 * ---------------
 * When the server is started from inside another tool's process tree (a DSH
 * session, for example), it inherits that tool's Windows Job object and any
 * sandbox restrictions. Two failures were observed that way:
 *
 *   * `spawn EROFS` -- the server could not start PowerShell at all, so every
 *     status probe and the hardware collector failed.
 *   * The server was terminated whenever the parent session ended, which looked
 *     like "the services keep dying on their own".
 *
 * A task registered with Task Scheduler runs as a child of the Task Scheduler
 * service (svchost), outside any such job object, so it survives the parent and
 * can spawn freely. This module registers, starts, stops and removes that task.
 *
 * Usage:
 *   node tools/task-control.js install     register the task (logon trigger)
 *   node tools/task-control.js start       start it now
 *   node tools/task-control.js stop        stop it
 *   node tools/task-control.js restart     stop then start
 *   node tools/task-control.js status      report task + port state
 *   node tools/task-control.js uninstall   remove the task
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const TASK_NAME = 'HwMonitorServer';
const NODE = process.execPath;
const SERVER = path.join(ROOT, 'server.js');

/**
 * Run a PowerShell script from a temp file.
 *
 * The script text is passed as a file rather than inline so that Chinese paths
 * (which this project's directory contains) never have to survive PowerShell's
 * command-line decoding.
 *
 * @param {string[]} lines ASCII-only PowerShell statements
 * @param {object} params   values delivered through a UTF-8 JSON sidecar file
 */
function runPs(lines, params = {}) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const psPath = path.join(os.tmpdir(), `hwm-task-${stamp}.ps1`);
  const argPath = path.join(os.tmpdir(), `hwm-task-${stamp}.json`);

  fs.writeFileSync(psPath, ['param([string]$Spec)', '$ErrorActionPreference = "Stop"']
    .concat(lines).join('; '), 'utf8');
  fs.writeFileSync(argPath, JSON.stringify(params), 'utf8');

  try {
    return execFileSync('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-Spec', argPath],
      { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  } finally {
    try { fs.unlinkSync(psPath); } catch {}
    try { fs.unlinkSync(argPath); } catch {}
  }
}

const READ_SPEC = [
  '$json = [System.IO.File]::ReadAllText($Spec, [System.Text.Encoding]::UTF8)',
  '$o = $json | ConvertFrom-Json',
];

function install() {
  const out = runPs(READ_SPEC.concat([
    '$action = New-ScheduledTaskAction -Execute $o.node -Argument $o.args -WorkingDirectory $o.root',
    // Delay slightly after logon so the task does not compete with startup I/O.
    '$trigger = New-ScheduledTaskTrigger -AtLogOn',
    '$trigger.Delay = "PT20S"',
    '$principal = New-ScheduledTaskPrincipal -UserId $o.user -LogonType Interactive -RunLevel Highest',
    // No execution time limit, and do not stop when the machine switches to battery.
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew',
    'if (Get-ScheduledTask -TaskName $o.name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $o.name -Confirm:$false }',
    'Register-ScheduledTask -TaskName $o.name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "HwMonitor hardware and DSH usage monitor" | Out-Null',
    'Write-Output "installed"',
  ]), {
    name: TASK_NAME,
    node: NODE,
    // Quote both paths: the project directory contains spaces and Chinese text.
    args: `"${SERVER}"`,
    root: ROOT,
    user: `${process.env.USERDOMAIN}\\${process.env.USERNAME}`,
  });
  return out.trim();
}

function start() {
  return runPs(READ_SPEC.concat([
    'Start-ScheduledTask -TaskName $o.name',
    'Write-Output "started"',
  ]), { name: TASK_NAME }).trim();
}

function stop() {
  return runPs(READ_SPEC.concat([
    'Stop-ScheduledTask -TaskName $o.name -ErrorAction SilentlyContinue',
    'Write-Output "stopped"',
  ]), { name: TASK_NAME }).trim();
}

function uninstall() {
  return runPs(READ_SPEC.concat([
    'Stop-ScheduledTask -TaskName $o.name -ErrorAction SilentlyContinue',
    'Unregister-ScheduledTask -TaskName $o.name -Confirm:$false -ErrorAction SilentlyContinue',
    'Write-Output "uninstalled"',
  ]), { name: TASK_NAME }).trim();
}

function taskInfo() {
  try {
    const out = runPs(READ_SPEC.concat([
      '$t = Get-ScheduledTask -TaskName $o.name -ErrorAction SilentlyContinue',
      'if (-not $t) { Write-Output "absent" } else {',
      '  $i = Get-ScheduledTaskInfo -TaskName $o.name',
      '  Write-Output ("state=" + $t.State + " lastResult=" + $i.LastTaskResult + " lastRun=" + $i.LastRunTime)',
      '}',
    ]), { name: TASK_NAME });
    return out.trim();
  } catch (e) {
    return `error: ${e.message}`;
  }
}

/** Whether a TCP port is accepting connections. */
function portOpen(port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

(async () => {
  const cmd = (process.argv[2] || 'status').toLowerCase();

  switch (cmd) {
    case 'install':
      console.log(`  ${install()}`);
      console.log(`  任务名: ${TASK_NAME}`);
      console.log(`  命令:   "${NODE}" "${SERVER}"`);
      console.log('  触发:   登录后 20 秒自动启动');
      break;

    case 'start':
      console.log(`  ${start()}`);
      await new Promise((r) => setTimeout(r, 12000));
      break;

    case 'stop':
      console.log(`  ${stop()}`);
      break;

    case 'restart':
      console.log(`  ${stop()}`);
      await new Promise((r) => setTimeout(r, 3000));
      console.log(`  ${start()}`);
      await new Promise((r) => setTimeout(r, 12000));
      break;

    case 'uninstall':
      console.log(`  ${uninstall()}`);
      break;

    case 'status':
    default:
      break;
  }

  const open = await portOpen(8080);
  console.log('');
  console.log(`  任务状态: ${taskInfo()}`);
  console.log(`  8080 端口: ${open ? 'OPEN' : 'closed'}`);
  process.exit(0);
})();
