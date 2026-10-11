// Verify the service matchers against the command lines that actually occur.
//
// Two bugs are guarded against here:
//
//   1. A matcher that only looks at the command line would treat a wrapper shell
//      (`cmd.exe /c cd <dir> && node server.js`) as the service itself. Killing
//      that wrapper terminates the session that issued the command, which
//      happened repeatedly during development. The process *name* must therefore
//      be checked too.
//   2. A matcher that requires the script argument immediately after the
//      executable fails when the launcher passes an absolute path (Task
//      Scheduler does), so a running server was reported as stopped.

const path = require('path');
const services = require(path.join(__dirname, '..', 'lib', 'services'));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

/** Minimal process record in the shape the probe produces. */
const proc = (name, cmd) => ({ pid: 1, name, cmd });

// ------------------------------------------------------------------ HwMonitor
console.log('=== HwMonitor: must match ===');
const hw = services.SERVICES.hwmonitor;
const hwShould = [
  proc('node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\User\\Desktop\\其他\\项目\\HwMonitor\\server.js"'),
  proc('node.exe', '"C:\\Program Files\\nodejs\\node.exe"  server.js '),
  proc('node.exe', 'C:\\Program Files\\nodejs\\node.exe C:\\Users\\User\\Desktop\\其他\\项目\\HwMonitor\\server.js'),
  proc('node.exe', 'node.exe C:/Users/User/Desktop/HwMonitor/server.js'),
  proc('node', 'node server.js'),
];
for (const p of hwShould) check(p.cmd.slice(0, 70), services.serviceMatches ? services.serviceMatches(hw, p) : hw.procName.test(p.name) && hw.match.test(p.cmd));

console.log('\n=== HwMonitor: must NOT match (wrappers and other programs) ===');
const hwShouldNot = [
  // Wrapper shells: same trailing text, but the process is not node.
  proc('powershell.exe', 'powershell -Command "cd C:\\Users\\User\\Desktop\\其他\\项目\\HwMonitor; node server.js"'),
  proc('cmd.exe', 'cmd.exe /c cd /d "C:\\Users\\User\\Desktop\\其他\\项目\\HwMonitor" && node server.js'),
  // A different node program.
  proc('node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\myserver.js"'),
  // The DSH host.
  proc('node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web'),
];
for (const p of hwShouldNot) {
  const hit = services.serviceMatches ? services.serviceMatches(hw, p) : (hw.procName.test(p.name) && hw.match.test(p.cmd));
  check(p.cmd.slice(0, 70), !hit, hit ? 'UNEXPECTED MATCH' : '');
}

// ------------------------------------------------------------------------ DSH
console.log('\n=== DSH ===');
const dsh = services.SERVICES.dsh;
const test = (svc, p) => services.serviceMatches(svc, p);
check('real DSH matches', test(dsh, proc('node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web')));
check('dsh.cmd shim does not match', !test(dsh, proc('cmd.exe', 'cmd.exe /c C:\\Users\\User\\AppData\\Roaming\\npm\\dsh.cmd web')));

// ----------------------------------------------------------------------- FRPC
console.log('\n=== FRPC ===');
const frpc = services.SERVICES.frpc;
// Generic paths are used here rather than this machine's real ones, so the test
// does not embed a developer's directory layout in a public repository.
check('absolute config path matches', test(frpc, proc('frpc.exe', 'C:\\tools\\FRPC\\frpc.exe -c C:\\tools\\FRPC\\frpc_all.toml')));
check('relative config path matches', test(frpc, proc('frpc.exe', 'frpc.exe -c frpc_all.toml')));
check('a different config does not match', !test(frpc, proc('frpc.exe', 'frpc.exe -c frpc_other.toml')));
check('cmd wrapper does not match', !test(frpc, proc('cmd.exe', 'cmd /c start frpc.exe -c frpc_all.toml')));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
