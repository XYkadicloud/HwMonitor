// Test the SSH session manager against the machine's own SSH server.
//
// The machine runs an OpenSSH server on 127.0.0.1 and the user has an ed25519
// key, so key-based auth can be exercised end to end without needing an external
// host or credentials. Non-destructive: only read-only commands are run.

const path = require('path');
const os = require('os');
const fs = require('fs');
const LIB = path.join(__dirname, '..', 'lib');
const { SshSession, SshManager, SSH_EXE } = require(path.join(LIB, 'ssh'));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== environment ===');
  console.log(`  ssh binary: ${SSH_EXE}`);
  check('ssh.exe exists', fs.existsSync(SSH_EXE));

  const user = process.env.USERNAME;
  const keyPath = path.join(os.homedir(), '.ssh', 'id_ed25519');
  check('private key exists', fs.existsSync(keyPath), keyPath);

  console.log('\n=== connect to localhost with the user key ===');
  const s = new SshSession({
    host: '127.0.0.1',
    port: 22,
    user,
    keyPath,
    acceptNewHostKey: true,
  });

  const outputs = [];
  const doneEvents = [];
  let exitEvent = null;
  s.on('output', (e) => outputs.push(e));
  s.on('command-done', (e) => doneEvents.push(e));
  s.on('exit', (e) => { exitEvent = e; });

  s.start();
  await sleep(4000);

  check('process is alive', s.alive, `pid=${s.proc ? s.proc.pid : null}`);
  if (!s.alive) {
    console.log('  stderr seen:', outputs.filter((o) => o.stream === 'stderr').map((o) => o.text).join('').slice(0, 500));
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }

  console.log('\n=== run a command ===');
  outputs.length = 0;
  const r1 = s.run('echo SSH_MARKER_ONE');
  check('run() accepted', r1.ok === true, r1.error || `seq=${r1.seq}`);
  await sleep(4000);

  const text1 = outputs.map((o) => o.text).join('');
  check('command-done fired', doneEvents.length >= 1, `${doneEvents.length} event(s)`);
  check('output contains the marker', /SSH_MARKER_ONE/.test(text1));
  check('no auth error', !/Permission denied/i.test(text1),
    (text1.match(/Permission denied[^\n]*/) || [''])[0]);

  console.log('\n=== command execution (each command is its own shell) ===');
  // Windows OpenSSH 8.1 cannot provide a usable pseudo-terminal over a pipe, so
  // no tty is requested and shell state does not persist between commands. The
  // session reports this via `stateful: false` and the UI states it plainly.
  outputs.length = 0;
  const before = doneEvents.length;
  s.run('echo SECOND_COMMAND_OK');
  await sleep(3500);
  const text2 = outputs.map((o) => o.text).join('');
  check('subsequent command completed', doneEvents.length >= before + 1,
    `${doneEvents.length - before} new`);
  check('second command output present', /SECOND_COMMAND_OK/.test(text2));

  console.log('\n=== ANSI control sequences must be stripped ===');
  check('no escape sequences in output', !/\u001b/.test(text2),
    /\u001b/.test(text2) ? 'ESC present' : 'clean');

  console.log('\n=== command echo must not be duplicated ===');
  outputs.length = 0;
  s.run('echo UNIQUE_MARKER_XYZ');
  await sleep(3500);
  const textEcho = outputs.map((o) => o.text).join('');
  const markerLines = textEcho.split('\n').filter((l) => l.includes('UNIQUE_MARKER_XYZ'));
  console.log(`      lines mentioning the marker: ${markerLines.length}`);
  for (const l of markerLines) console.log(`        ${JSON.stringify(l)}`);
  // One line from our prompt, one line of actual output. Without a tty there is
  // no terminal echo, so more than two would indicate duplication.
  check('marker not duplicated', markerLines.length <= 2, `${markerLines.length} lines`);

  console.log('\n=== statefulness is reported honestly ===');
  check('stateful flag is false', s.info().stateful === false,
    'no pseudo-terminal available on this OpenSSH build');

  console.log('\n=== concurrency guard ===');
  outputs.length = 0;
  s.run('sleep 3');
  const r2 = s.run('echo SHOULD_BE_REJECTED');
  check('parallel command rejected', r2.ok === false, r2.error || '');
  await sleep(5000);

  console.log('\n=== info ===');
  const info = s.info();
  console.log(`  ${JSON.stringify(info)}`);
  check('auth mode reported as key', info.authMode === 'key', info.authMode);
  check('command count tracked', info.commandCount >= 4, `${info.commandCount}`);
  check('not stuck pending', info.pending === 0, `pending=${info.pending}`);

  console.log('\n=== cleanup ===');
  const mgr = new SshManager();
  mgr.sessions.set(s.id, s);
  mgr.destroy(s.id);
  check('session removed', mgr.get(s.id) === null);
  mgr.disposeAll();

  console.log('\n=== failure path: unreachable host must not hang ===');
  const bad = new SshSession({ host: '127.0.0.1', port: 9, user, keyPath, timeoutMs: 15000 });
  const badOut = [];
  bad.on('output', (e) => badOut.push(e));
  bad.start();
  // ConnectTimeout is 10s; allow a little more for the failure to be reported.
  await sleep(16000);
  const badText = badOut.map((o) => o.text).join('');
  check('unreachable port reported an error', /refused|denied|timed out|Connection|closed/i.test(badText),
    badText.replace(/\s+/g, ' ').slice(0, 160));
  bad.dispose();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
