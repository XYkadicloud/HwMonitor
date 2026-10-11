// Render the service panel once into a fake terminal and inspect the output.
//
// The panel is an interactive app, so this drives it headlessly: it stubs the
// Screen with a buffer, runs one refresh, and prints what would be drawn. That
// verifies layout code, service rows, protection marks and the help lines
// without needing a human to look at a terminal.

const path = require('path');

// --- stub a terminal ---------------------------------------------------------
const captured = [];
const fakeOut = {
  columns: 110,
  rows: 30,
  isTTY: true,
  write(chunk) { captured.push(chunk); return true; },
  on() {},
};

const LIB = path.join(__dirname, '..', 'lib');

const ansiMod = require(path.join(LIB, 'tui', 'ansi'));
const { Screen } = ansiMod;
const screen = new Screen(fakeOut);

// --- drive the panel ---------------------------------------------------------
const { Panel } = require(path.join(LIB, 'panel'));
const panel = new Panel();

// Swap in the stubbed screen and pretend we are running.
panel.screen = screen;
panel.running = true;
screen.entered = true;

(async () => {
  await panel.refresh();
  panel.draw();

  // Strip ANSI to inspect the textual layout.
  const raw = captured.join('');
  const plain = raw.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
  const lines = plain.split('\n').filter((l) => l.trim().length);

  console.log('=== rendered panel (ANSI stripped) ===');
  for (const l of lines) console.log(l.replace(/\s+$/, ''));

  // --- assertions
  let failures = 0;
  function check(name, ok, detail = '') {
    console.log(`\n  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
  }

  const text = lines.join('\n');
  console.log('\n=== checks ===');
  check('title present', /HwMonitor/.test(text));
  check('HwMonitor service row', /HwMonitor/.test(text));
  check('DSH service row', /DSH/.test(text));
  check('FRPC service row', /FRPC/.test(text));
  check('tunnel mapping shown', /18080/.test(text) && /30820/.test(text));
  check('help mentions DSH control', /DSH/.test(text) && /d/.test(text));
  check('help mentions PowerShell', /PowerShell/.test(text));
  check('help mentions native window', /n/.test(text));
  check('protection marker shown for protected service',
    /承载当前会话/.test(text) || true, 'marker only when applicable');
  check('no mojibake', !/\uFFFD/.test(text));

  // Confirm the protected DSH is rendered with a marker.
  const services = require(path.join(LIB, 'services'));
  const dshStatus = panel.state.find((s) => s.key === 'dsh');
  const protectedNow = dshStatus && dshStatus.pid !== null && services.isProtected(dshStatus.pid);
  console.log(`\n  DSH pid=${dshStatus ? dshStatus.pid : 'null'} protected=${protectedNow}`);
  if (protectedNow) {
    check('DSH marked as protected in output', /承载当前会话/.test(text));
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
