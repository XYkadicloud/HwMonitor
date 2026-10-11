// Test the terminal session manager: command execution, output capture,
// sentinel-based completion, cwd persistence, and failure handling.
//
// Non-destructive: only read-only commands are run.

const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { TerminalSession, TerminalManager } = require(path.join(LIB, 'terminal'));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== TerminalManager.isEnabled (fail-closed policy) ===');
  const mgr = new TerminalManager({ cwd: process.cwd() });
  check('disabled when no password is set', mgr.isEnabled(false) === false);
  check('enabled when a password is set', mgr.isEnabled(true) === true);

  console.log('\n=== session lifecycle ===');
  const s = mgr.create();
  check('session created', !!s && s.alive, `id=${s.id}`);
  await sleep(2500); // let PowerShell boot

  console.log('\n=== command execution ===');
  const outputs = [];
  const doneEvents = [];
  s.on('output', (e) => outputs.push(e));
  // The listener must be attached before run(): a fast command can complete
  // before the test would otherwise get a chance to subscribe.
  s.on('command-done', (e) => doneEvents.push(e));

  const r1 = s.run('Write-Output "MARKER_ONE"');
  check('run() accepted', r1.ok === true, `seq=${r1.seq}`);
  await sleep(2500);
  const text1 = outputs.map((o) => o.text).join('');
  check('command-done fired', doneEvents.length >= 1,
    doneEvents.length ? `seq=${doneEvents[0].seq}` : 'no event');
  check('output contains marker', /MARKER_ONE/.test(text1));
  check('prompt echoed', /PS>/.test(text1));

  console.log('\n=== sequential commands ===');
  outputs.length = 0;
  const before2 = doneEvents.length;
  s.run('Write-Output "MARKER_TWO"');
  await sleep(2500);
  const text2 = outputs.map((o) => o.text).join('');
  check('second command output captured', /MARKER_TWO/.test(text2));
  check('second command completed', doneEvents.length > before2,
    `events=${doneEvents.length}`);

  console.log('\n=== state persists across commands ===');
  outputs.length = 0;
  s.run('$script:hwmTest = 4242');
  await sleep(2200);
  outputs.length = 0;
  s.run('Write-Output "VAL=$script:hwmTest"');
  await sleep(2200);
  const text3 = outputs.map((o) => o.text).join('');
  check('variable persisted between commands', /VAL=4242/.test(text3),
    text3.split('\n').filter((l) => /VAL=/.test(l)).join(' ') || 'not found');

  console.log('\n=== UTF-8 handling (Chinese path) ===');
  outputs.length = 0;
  s.run('Write-Output $PWD.Path');
  await sleep(2000);
  const text4 = outputs.map((o) => o.text).join('');
  const hasMojibake = /\uFFFD|鍏朵粬|椤圭洰/.test(text4);
  check('Chinese path is not mojibake', !hasMojibake,
    text4.split('\n').filter((l) => l.includes('HwMonitor')).join(' ').slice(0, 90));

  console.log('\n=== error output ===');
  outputs.length = 0;
  s.run('Write-Error "INTENTIONAL_TEST_ERROR"');
  await sleep(2500);
  const text5 = outputs.map((o) => o.text).join('');
  check('error text surfaced to client', /INTENTIONAL_TEST_ERROR/.test(text5));

  console.log('\n=== concurrency guard ===');
  outputs.length = 0;
  s.run('Start-Sleep -Seconds 3');
  const r2 = s.run('Write-Output "SHOULD_BE_REJECTED"');
  check('second command rejected while one is running',
    r2.ok === false, r2.error || '');
  await sleep(4500);

  console.log('\n=== session info ===');
  const info = s.info();
  console.log(`      pid=${info.pid} cwd=${info.cwd} commands=${info.commandCount} alive=${info.alive}`);
  check('command count reflects activity', info.commandCount >= 6, `count=${info.commandCount}`);

  console.log('\n=== cleanup ===');
  mgr.destroy(s.id);
  check('session removed from manager', mgr.get(s.id) === null);
  mgr.disposeAll();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
