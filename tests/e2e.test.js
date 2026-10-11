// End-to-end verification of auth, API surface, and DSH incremental correctness.
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8080';
let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' 鈥?' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' 鈥?' + detail : ''}`); }
}

function request(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + urlPath);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('=== 1. unauthenticated surface (no password configured) ===');
  let r = await request('GET', '/healthz');
  check('/healthz 200', r.status === 200);
  const health = JSON.parse(r.body);
  check('collector healthy', health.collector === true);
  check('dsh sessions found', health.dshSessions > 0, `${health.dshSessions} sessions`);

  r = await request('GET', '/');
  check('index.html served', r.status === 200 && /HwMonitor/.test(r.body));
  check('html content-type', /text\/html/.test(r.headers['content-type'] || ''));

  r = await request('GET', '/app.js');
  check('app.js served', r.status === 200 && /EventSource/.test(r.body));
  r = await request('GET', '/styles.css');
  check('styles.css served', r.status === 200);

  console.log('\n=== 2. path traversal protection ===');
  for (const bad of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/../../data/config.json']) {
    r = await request('GET', bad);
    check(`blocked ${bad}`, r.status === 403 || r.status === 404, `status ${r.status}`);
  }

  console.log('\n=== 3. unknown api endpoint ===');
  r = await request('GET', '/api/nonexistent');
  check('404 for unknown api', r.status === 404);

  console.log('\n=== 4. state payload integrity ===');
  r = await request('GET', '/api/state');
  const st = JSON.parse(r.body);
  check('sample present', !!st.sample);
  check('battery percent is a number', typeof st.sample.battery.percent === 'number', `${st.sample.battery.percent}%`);
  check('battery remaining mWh present', st.sample.battery.remainingMwh > 0, `${st.sample.battery.remainingMwh} mWh`);
  check('battery design capacity present', st.hello.batteryStatic.designCapacityMwh > 0, `${st.hello.batteryStatic.designCapacityMwh} mWh`);
  check('battery health computed', st.hello.batteryStatic.healthPct > 0, `${st.hello.batteryStatic.healthPct}%`);
  check('cycle count present', st.hello.batteryStatic.cycleCount > 0, `${st.hello.batteryStatic.cycleCount}`);
  check('volumes have capacity', st.sample.volumes.length > 0 && st.sample.volumes.every((v) => v.sizeBytes > 0));
  check('cpu cores reported', st.sample.cpu.cores.length === st.hello.static.cpuThreads,
    `${st.sample.cpu.cores.length} cores vs ${st.hello.static.cpuThreads} threads`);
  check('no duplicate _Total core rows', !st.sample.cpu.cores.some((c) => /_Total/.test(c.name)));
  check('memory total present', st.sample.memory.totalBytes > 0);
  check('self cost reported', typeof st.sample.selfCostMs === 'number', `${st.sample.selfCostMs}ms`);
  check('dsh processes detected', st.sample.dshProcesses.length > 0, `${st.sample.dshProcesses.length} node processes`);
  check('dsh-host role identified', st.sample.dshProcesses.some((p) => p.role === 'dsh-host'));
  check('thermal honestly unsupported', st.sample.thermal.supported === false || st.sample.thermal.zones.length > 0);

  console.log('\n=== 5. series shape ===');
  r = await request('GET', '/api/series');
  const ser = JSON.parse(r.body);
  check('series has points', ser.series.length > 0, `${ser.series.length} points`);
  check('series keys present', ser.series.every((p) => 'cpu' in p && 'mem' in p && 'power' in p));

  console.log('\n=== 6. DSH report integrity ===');
  r = await request('GET', '/api/dsh');
  const dsh = JSON.parse(r.body);
  check('grand totals nonzero', dsh.grand.inputTokens > 0 && dsh.grand.outputTokens > 0,
    `in=${dsh.grand.inputTokens} out=${dsh.grand.outputTokens}`);
  check('models aggregated', dsh.byModel.length > 0, `${dsh.byModel.length} models`);
  check('tools aggregated', dsh.byTool.length > 0, `${dsh.byTool.length} tools`);
  check('sessions listed', dsh.sessions.length > 0, `${dsh.sessions.length} sessions`);
  check('active session detected', dsh.grand.activeSessions >= 1);
  check('current session has todos or title', !!(dsh.sessions[0].title || dsh.sessions[0].todos));
  check('workspace path decoded', /^[A-Za-z]:\\/.test(dsh.sessions[0].cwd || ''), dsh.sessions[0].cwd);
  check('report is reasonably sized', r.body.length < 120000, `${(r.body.length / 1024).toFixed(0)} KB`);

  console.log('\n=== 7. DSH incremental scan does not double count ===');
  const before = { in: dsh.grand.inputTokens, out: dsh.grand.outputTokens, calls: dsh.grand.calls };
  r = await request('POST', '/api/dsh/rescan');
  check('rescan returns ok', r.status === 200);
  const after = JSON.parse(r.body).report.grand;
  check('input tokens stable after full rescan', after.inputTokens === before.in,
    `${before.in} -> ${after.inputTokens}`);
  check('output tokens stable after full rescan', after.outputTokens === before.out,
    `${before.out} -> ${after.outputTokens}`);
  check('call count stable after full rescan', after.calls === before.calls,
    `${before.calls} -> ${after.calls}`);

  console.log('\n=== 8. config round trip ===');
  r = await request('GET', '/api/config');
  const cfgBefore = JSON.parse(r.body);
  check('config readable', cfgBefore.port === 8080);
  check('password not leaked', !('password' in cfgBefore), 'only passwordSet flag exposed');

  r = await request('POST', '/api/config', { body: { thresholds: { batteryLowPct: 33 } } });
  check('config update accepted', r.status === 200);
  const cfgAfter = JSON.parse(r.body);
  check('threshold persisted', cfgAfter.thresholds.batteryLowPct === 33, `= ${cfgAfter.thresholds.batteryLowPct}`);
  // Restore.
  await request('POST', '/api/config', { body: { thresholds: { batteryLowPct: 20 } } });

  console.log('\n=== 9. password protection ===');
  r = await request('POST', '/api/config', { body: { password: 'test-secret-123' } });
  check('password set', r.status === 200 && JSON.parse(r.body).passwordSet === true);

  // A fresh client with no cookie must now be rejected.
  r = await request('GET', '/api/state');
  check('api blocked without cookie', r.status === 401, `status ${r.status}`);
  r = await request('GET', '/api/dsh');
  check('dsh blocked without cookie', r.status === 401);
  r = await request('GET', '/healthz');
  check('healthz still open', r.status === 200);

  r = await request('POST', '/api/login', { body: { password: 'wrong-password' } });
  check('wrong password rejected', r.status === 401, `status ${r.status}`);

  r = await request('POST', '/api/login', { body: { password: 'test-secret-123' } });
  check('correct password accepted', r.status === 200);
  const setCookie = r.headers['set-cookie'];
  check('session cookie issued', Array.isArray(setCookie) && /hwm_session=/.test(setCookie[0]));
  check('cookie is HttpOnly', /HttpOnly/i.test(setCookie[0]));
  const cookie = setCookie[0].split(';')[0];

  r = await request('GET', '/api/state', { cookie });
  check('api allowed with cookie', r.status === 200);
  r = await request('GET', '/api/dsh', { cookie });
  check('dsh allowed with cookie', r.status === 200);

  console.log('\n=== 10. SSE requires auth ===');
  r = await request('GET', '/api/stream');
  check('stream blocked without cookie', r.status === 401, `status ${r.status}`);

  console.log('\n=== 11. clear password and confirm open again ===');
  r = await request('POST', '/api/config', { body: { password: '' }, cookie });
  check('password cleared', r.status === 200 && JSON.parse(r.body).passwordSet === false);
  r = await request('GET', '/api/state');
  check('api open again', r.status === 200);

  console.log(`\n${'='.repeat(52)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(52));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
