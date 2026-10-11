// Final integrity check: README is valid UTF-8 with no mojibake, and the
// encoding constraints for each file class hold.
//
// The constraints encode two bugs that were actually hit during development:
//  - .bat files must be pure ASCII (cmd.exe mis-parses non-ASCII bytes).
//  - collector.ps1 must be ASCII-only or carry a UTF-8 BOM (PowerShell 5.1
//    decodes non-BOM files with the system ANSI codepage).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

function nonAsciiCount(buf) {
  let n = 0;
  for (const b of buf) if (b > 127) n++;
  return n;
}

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

console.log('=== README integrity ===');
const readmePath = path.join(ROOT, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const replacementChars = (readme.match(/\uFFFD/g) || []).length;
check('no mojibake replacement characters', replacementChars === 0, `${replacementChars} found`);
check('contains 充电输入功率', readme.includes('充电输入功率'));
check('contains 启动监控.bat', readme.includes('启动监控.bat'));
check('contains the .bat ASCII warning', readme.includes('纯 ASCII'));
check('mentions power states', readme.includes('ac-idle'));
console.log('  first line: ' + readme.split('\n')[0]);

console.log('\n=== encoding constraints ===');
const batFiles = ['启动监控.bat', '停止监控.bat'];
for (const f of batFiles) {
  const p = path.join(ROOT, f);
  const buf = fs.readFileSync(p);
  check(`${f} is pure ASCII`, nonAsciiCount(buf) === 0, `${nonAsciiCount(buf)} non-ASCII bytes`);
}

const psFile = path.join(ROOT, 'ps', 'collector.ps1');
const psBuf = fs.readFileSync(psFile);
const psNonAscii = nonAsciiCount(psBuf);
// Either pure ASCII, or non-ASCII accompanied by a BOM. Currently only the BOM
// bytes themselves are non-ASCII, which is the ideal state.
check('collector.ps1 is ASCII-only apart from an optional BOM',
  psNonAscii === 0 || (psNonAscii === 3 && hasBom(psBuf)),
  `non-ASCII=${psNonAscii} bom=${hasBom(psBuf)}`);

const invBuf = fs.readFileSync(path.join(ROOT, 'ps', 'inventory.ps1'));
check('inventory.ps1 is pure ASCII', nonAsciiCount(invBuf) === 0);

// JS files are read as UTF-8 by Node unconditionally, so Chinese there is fine.
for (const f of ['lib/labels.js', 'lib/launcher-msg.js']) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  check(`${f} decodes as valid UTF-8`, !text.includes('\uFFFD'));
}

console.log('\n=== launcher wiring ===');
const launcher = fs.readFileSync(path.join(ROOT, '启动监控.bat'), 'utf8');
check('launcher calls launcher-msg.js', launcher.includes('launcher-msg.js'));
check('launcher does NOT open a browser', !/^start .*http/m.test(launcher) && !launcher.includes('http://127.0.0.1:%PORT%/'));
check('launcher reads the pid file', launcher.includes('server.pid'));
check('launcher verifies server.js before killing',
  launcher.includes("CommandLine -match 'server\\.js'"));
check('launcher avoids keyword self-matching', !launcher.includes('HwMonitor\\ps'));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
