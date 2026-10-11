// Verify the incremental multi-frame decoder against real DSH session logs.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SessionLogReader, parseJsonl } = require('../lib/zstd-jsonl');

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');

function findLogs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findLogs(p, acc);
    else if (e.name === 'session.v4.jsonl.zstd') acc.push(p);
  }
  return acc;
}

const logs = findLogs(sessionsRoot).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
console.log(`found ${logs.length} session logs`);

const target = logs[0];
const buf = fs.readFileSync(target);
console.log(`\n=== whole-file decode: ${path.basename(path.dirname(target))} (${buf.length} bytes) ===`);
const r1 = new SessionLogReader();
const t0 = Date.now();
const text1 = r1.update(target, buf);
console.log(`decoded ${text1.length} chars in ${Date.now() - t0}ms`);
const evs = parseJsonl(text1);
console.log(`events: ${evs.length}`);

// Incremental correctness: feeding the file in 64KB growing slices must yield
// exactly the same text as a single whole-file decode.
console.log('\n=== incremental decode equivalence (64KB slices) ===');
const r2 = new SessionLogReader();
let inc = '';
const step = 64 * 1024;
const t1 = Date.now();
for (let n = step; n <= buf.length + step; n += step) {
  inc += r2.update(target, buf.subarray(0, Math.min(n, buf.length)));
}
console.log(`incremental decoded ${inc.length} chars in ${Date.now() - t1}ms`);
console.log(`MATCH: ${inc === text1 ? 'YES' : 'NO  <-- MISMATCH'}`);

// Resumability: poll repeatedly with no growth must return empty.
console.log('\n=== idle poll returns nothing ===');
const r3 = new SessionLogReader();
r3.update(target, buf);
const again = r3.update(target, buf);
console.log(`second identical poll length: ${again.length} (expect 0)`);

// Truncated tail must not be consumed or throw.
console.log('\n=== truncated tail handling ===');
const r4 = new SessionLogReader();
const truncated = buf.subarray(0, buf.length - 3);
const partial = r4.update(target, truncated);
const recovered = r4.update(target, buf);
console.log(`partial: ${partial.length} chars, after full file: ${recovered.length} chars`);
console.log(`total equals full: ${partial.length + recovered.length === text1.length ? 'YES' : 'NO'}`);

// Multi-file sweep: every log must decode without throwing.
console.log('\n=== sweep all logs ===');
let okCount = 0;
let totalEvents = 0;
let totalBytes = 0;
const t2 = Date.now();
for (const log of logs) {
  try {
    const b = fs.readFileSync(log);
    totalBytes += b.length;
    const r = new SessionLogReader();
    const ev = parseJsonl(r.update(log, b));
    totalEvents += ev.length;
    okCount++;
  } catch (e) {
    console.log(`FAIL ${log}: ${e.message}`);
  }
}
console.log(`decoded ${okCount}/${logs.length} logs, ${(totalBytes / 1048576).toFixed(1)} MB -> ${totalEvents} events in ${Date.now() - t2}ms`);
