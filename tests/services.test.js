// Verify the service manager's detection logic against the live machine.
//
// Read-only: this only inspects state, it does not start or stop anything.

const svc = require('../lib/services');

(async () => {
  console.log('=== service definitions ===');
  for (const k of svc.ORDER) {
    const s = svc.SERVICES[k];
    console.log(`  ${k.padEnd(11)} ${s.name.padEnd(10)} ports=[${s.ports.join(',')}]`);
    console.log(`      match: ${s.match}`);
  }
  console.log(`  FRPC dir: ${svc.FRPC_DIR}`);

  console.log('\n=== process listing ===');
  const procs = await svc.listProcesses();
  console.log(`  ${procs.length} processes visible`);
  const withCmd = procs.filter((p) => p.cmd).length;
  console.log(`  ${withCmd} have a readable command line`);

  console.log('\n=== live status ===');
  const all = await svc.statusAll();
  for (const s of all) {
    console.log(`  ${s.name.padEnd(10)} running=${String(s.running).padEnd(5)} pid=${String(s.pid).padEnd(7)} ${s.detail}`);
    for (const p of s.ports) {
      console.log(`      port ${p.port}: ${p.open ? 'open' : 'closed'}${p.pids.length ? ' pids=' + p.pids.join(',') : ''}`);
    }
  }

  console.log('\n=== match safety check ===');
  // The manager must never match a shell that merely mentions the project path.
  // Simulate the dangerous case: a wrapper command line containing the path.
  const dangerous = [
    { pid: 999001, name: 'powershell.exe', cmd: 'powershell -Command "cd C:\\Users\\User\\Desktop\\其他\\项目\\HwMonitor; node server.js"' },
    { pid: 999002, name: 'cmd.exe', cmd: 'cmd /c cd /d "C:\\Users\\User\\Desktop\\其他\\项目\\HwMonitor" && node server.js' },
    { pid: 999003, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" server.js' },
  ];
  for (const k of svc.ORDER) {
    const re = svc.SERVICES[k].match;
    const hits = dangerous.filter((d) => re.test(d.cmd)).map((d) => d.pid);
    console.log(`  ${k.padEnd(11)} matches of simulated wrapper processes: ${hits.length ? hits.join(',') : 'none'}`);
  }
  console.log('  (hwmonitor intentionally matches the node.exe entry; wrappers must NOT match)');

  console.log('\n=== pid file location ===');
  console.log(`  ${require('path').join(svc.DATA_DIR, 'pids')}`);
  const fs = require('fs');
  if (fs.existsSync(require('path').join(svc.DATA_DIR, 'pids'))) {
    for (const f of fs.readdirSync(require('path').join(svc.DATA_DIR, 'pids'))) {
      console.log(`    ${f}: ${fs.readFileSync(require('path').join(svc.DATA_DIR, 'pids', f), 'utf8').replace(/\s+/g, ' ')}`);
    }
  } else {
    console.log('    (none yet)');
  }
})();
