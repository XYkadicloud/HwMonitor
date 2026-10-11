// Create the desktop shortcuts for HwMonitor.
//
// Two shortcuts, matching the two ways this project is meant to be used:
//
//   * 硬件监控     -- the native window. Lowest memory footprint: live figures
//                     plus one-click service control, no browser engine.
//   * 硬件监控网页 -- the full web UI in a browser: terminals (PowerShell and
//                     SSH), DSH statistics, hardware detail, settings.
//
// Everything is reachable from both, so there is no shortcut per action.
//
// Shortcut data is passed through a UTF-8 JSON file rather than command-line
// parameters. An earlier version passed the argument string via `-Args`, which
// collided with PowerShell's read-only automatic variable `$Args`, silently
// producing shortcuts with empty arguments (double-clicking opened a blank
// console). The JSON spec avoids that class of bug entirely.
//
// Run: node tools\make-shortcuts.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(os.homedir(), 'Desktop');
const NODE = process.execPath;
const hwmJs = path.join(ROOT, 'hwm.js');

// A single desktop shortcut, as requested.
//
// Double-clicking it starts the server (if it is not already running) and opens
// the web UI in the default browser. The browser is the interface: it carries the
// live figures, the DSH statistics, the service controls, the PowerShell terminal
// and the SSH terminal. The native window was archived in favour of this, so no
// second shortcut is needed.
//
// `hwm.js open-web` does the work: it probes the port, starts the server only when
// needed, then launches the browser. Nothing is registered for autostart -- the
// server runs only when this shortcut is used.
const SHORTCUTS = [
  {
    name: '硬件监控.lnk',
    args: `/c ""${NODE}" "${hwmJs}" open-web"`,
    desc: 'HwMonitor 硬件监控：启动服务端并打开网页界面',
    style: 7,
  },
];

// Superseded shortcuts. An earlier iteration created one per action; a single
// clear entry point is the point.
const OBSOLETE = [
  '启动硬件监控.lnk',
  '停止硬件监控.lnk',
  '服务控制台.lnk',
  '启动FRPC.lnk',
  '一键启动全部.lnk',
  '一键停止.lnk',
  '原生监控窗口.lnk',
  '重启DSH.lnk',
  '打开PowerShell.lnk',
  '硬件监控网页.lnk',
  '硬件监控控制台.lnk',
];

/**
 * Drive WScript.Shell from a JSON spec so quoting and encoding never travel
 * through a command line.
 */
function runShortcutScript(spec, bodyLines) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const specPath = path.join(os.tmpdir(), `hwm-sc-${stamp}.json`);
  const psPath = path.join(os.tmpdir(), `hwm-sc-${stamp}.ps1`);

  fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');
  // param() must be the first statement in a PowerShell script.
  fs.writeFileSync(psPath, ['param([string]$Spec)', '$ErrorActionPreference = "Stop"']
    .concat(bodyLines).join('; '), 'utf8');

  try {
    return execFileSync('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-Spec', specPath],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  } finally {
    try { fs.unlinkSync(specPath); } catch {}
    try { fs.unlinkSync(psPath); } catch {}
  }
}

const READ_SPEC = [
  '$json = [System.IO.File]::ReadAllText($Spec, [System.Text.Encoding]::UTF8)',
  '$o = $json | ConvertFrom-Json',
  '$shell = New-Object -ComObject WScript.Shell',
];

let failures = 0;

// --- remove superseded shortcuts -------------------------------------------
for (const name of OBSOLETE) {
  const p = path.join(DESKTOP, name);
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
      console.log(`REMOVED ${name}`);
    } catch (e) {
      console.log(`FAIL    could not remove ${name}: ${e.message}`);
      failures++;
    }
  }
}

// --- create the shortcuts ---------------------------------------------------
for (const sc of SHORTCUTS) {
  const linkPath = path.join(DESKTOP, sc.name);
  try {
    runShortcutScript(
      { link: linkPath, target: 'cmd.exe', args: sc.args, dir: ROOT, desc: sc.desc, style: sc.style },
      READ_SPEC.concat([
        '$sc = $shell.CreateShortcut($o.link)',
        '$sc.TargetPath = $o.target',
        '$sc.Arguments = $o.args',
        '$sc.WorkingDirectory = $o.dir',
        '$sc.Description = $o.desc',
        '$sc.WindowStyle = [int]$o.style',
        '$sc.IconLocation = $o.target',
        '$sc.Save()',
        'Write-Output "saved"',
      ])
    );
    console.log(`${fs.existsSync(linkPath) ? 'OK     ' : 'FAIL   '} ${sc.name}`);
    if (!fs.existsSync(linkPath)) failures++;
  } catch (e) {
    console.log(`FAIL    ${sc.name}: ${e.message}`);
    failures++;
  }
}

// --- verify the arguments actually landed ----------------------------------
// An empty argument string is exactly the bug this script exists to prevent, so
// it is asserted rather than assumed.
console.log('\n=== verification ===');
for (const sc of SHORTCUTS) {
  const linkPath = path.join(DESKTOP, sc.name);
  try {
    const out = runShortcutScript(
      { link: linkPath },
      READ_SPEC.concat([
        'if (Test-Path -LiteralPath $o.link) {',
        '  $sc = $shell.CreateShortcut($o.link)',
        '  Write-Output ("ARGS=" + $sc.Arguments)',
        '} else { Write-Output "ARGS=MISSING" }',
      ])
    );
    const args = (out.match(/ARGS=(.*)/) || [])[1] || '';
    const hasArgs = args.trim().length > 0;
    if (!hasArgs) failures++;
    console.log(`  ${hasArgs ? 'OK  ' : 'FAIL'} ${sc.name}`);
    console.log(`       ${args.trim()}`);
  } catch (e) {
    console.log(`  FAIL ${sc.name}: ${e.message}`);
    failures++;
  }
}

console.log(`\n${failures === 0 ? 'DONE - shortcuts created, arguments verified' : failures + ' problem(s)'}`);
process.exit(failures === 0 ? 0 : 1);
