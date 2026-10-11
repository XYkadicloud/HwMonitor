// Run collector.ps1 for N seconds and report what it produced.
const { spawn } = require('child_process');
const path = require('path');

const script = path.join(__dirname, '..', 'ps', 'collector.ps1');
const seconds = Number(process.argv[2] || 6);

const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HWM_INTERVAL_MS: '1000' },
});

const started = Date.now();
let buf = '';
const lines = [];
let stderr = '';

ps.stdout.setEncoding('utf8');
ps.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) lines.push({ at: Date.now() - started, line });
  }
});
ps.stderr.setEncoding('utf8');
ps.stderr.on('data', (d) => { stderr += d; });

ps.on('close', (code) => {
  console.log(`closed code=${code} after ${Date.now() - started}ms`);
  console.log(`lines: ${lines.length}`);
  console.log(`stderr: ${stderr.trim() ? stderr.trim().slice(0, 2000) : '(empty)'}`);

  if (!lines.length) { console.log('NO OUTPUT'); return; }

  const hello = JSON.parse(lines[0].line);
  console.log('\n=== LINE TIMING ===');
  for (const l of lines) console.log(`  +${l.at}ms  ${l.line.slice(0, 80)}`);
  console.log('\n=== HELLO ===');
  console.log(JSON.stringify(hello, null, 2).slice(0, 3000));

  const samples = lines.slice(1).map((l) => JSON.parse(l.line));
  console.log(`\n=== SAMPLES (${samples.length}) ===`);
  for (const s of samples) {
    const b = s.battery || {};
    const m = s.memory || {};
    const c = s.cpu || {};
    const g = s.gpu || {};
    const th = s.thermal || {};
    console.log(
      `seq=${s.seq} cpu=${c.totalPct}% cores=${(c.cores || []).map((x) => x.pct).join('/')} ` +
      `mhz=${c.currentMhz} mem=${m.usedPct}% avail=${m.availableBytes ? (m.availableBytes / 1048576).toFixed(0) + 'MB' : '-'} ` +
      `bat=${b.percent}% rem=${b.remainingMwh}mWh dis=${b.dischargeMw}mW chg=${b.chargeMw}mW ` +
      `gpu=${g.supported ? g.maxEnginePct + '%' : 'unsupported'} thermal=${th.supported ? 'yes' : 'unsupported'} ` +
      `procs=${(s.processes || []).length}`
    );
  }

  const last = samples[samples.length - 1];
  console.log('\n=== LAST SAMPLE (full) ===');
  console.log(JSON.stringify(last, null, 2).slice(0, 4000));
});

setTimeout(() => { console.log(`--- killing after ${seconds}s ---`); ps.kill(); }, seconds * 1000);
