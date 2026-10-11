// Verify the /api/addresses endpoint.
//
// Checks that it reports a usable LAN address, that virtual adapters are ranked
// below real ones, and that the payload includes everything the UI needs.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

function request(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: 8080, path: urlPath, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      timeout: 40000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('=== authentication ===');
  const unauth = await request('GET', '/api/addresses');
  check('unauthenticated request is refused', unauth.status === 401, `status ${unauth.status}`);

  const login = await request('POST', '/api/login', { body: { password: cfg.password } });
  check('login succeeds', login.status === 200);
  const cookie = (login.headers['set-cookie'] || [''])[0].split(';')[0];

  console.log('\n=== addresses payload ===');
  const r = await request('GET', '/api/addresses', { cookie });
  check('endpoint returns 200', r.status === 200, `status ${r.status}`);

  let d = null;
  try { d = JSON.parse(r.body); } catch {}
  check('payload parses', !!d);
  if (!d) { process.exit(1); }

  console.log(`  local       : ${d.local}`);
  console.log(`  primary     : ${d.primary}`);
  console.log(`  listeningAll: ${d.listeningOnAll}`);
  console.log(`  port        : ${d.port}`);
  console.log(`  addresses   : ${(d.addresses || []).length}`);
  for (const a of d.addresses || []) {
    console.log(`      ${String(a.label).padEnd(14)} ${String(a.url).padEnd(28)} ${a.adapter} (rank ${a.rank})`);
  }
  console.log(`  tunnels     : ${(d.tunnels || []).map((t) => t.name).join(', ')}`);

  check('local URL present', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(d.local || ''), d.local);
  check('port is a number', typeof d.port === 'number' && d.port > 0);
  check('listeningOnAll reported', typeof d.listeningOnAll === 'boolean');
  check('tunnels listed', Array.isArray(d.tunnels) && d.tunnels.length >= 2);

  const addrs = d.addresses || [];
  check('at least one address found', addrs.length > 0, `${addrs.length}`);

  // No loopback or link-local addresses should be offered as LAN options.
  check('no 127.x addresses in the list', !addrs.some((a) => a.ip.startsWith('127.')));
  check('no 169.254.x addresses in the list', !addrs.some((a) => a.ip.startsWith('169.254.')));

  // Real adapters must sort before virtual ones.
  const firstVirtual = addrs.findIndex((a) => a.kind === 'virtual' || a.kind === 'vpn');
  const lastReal = addrs.map((a) => a.kind).lastIndexOf('wifi') >= 0
    ? addrs.map((a) => a.kind).lastIndexOf('wifi')
    : addrs.map((a) => a.kind).lastIndexOf('ethernet');
  if (firstVirtual >= 0 && lastReal >= 0) {
    check('real adapters sort before virtual ones', lastReal < firstVirtual,
      `lastReal=${lastReal} firstVirtual=${firstVirtual}`);
  } else {
    console.log('      (no mix of real and virtual adapters to compare)');
  }

  // The primary URL must be the first address.
  if (addrs.length) {
    check('primary equals the first address', d.primary === addrs[0].url,
      `${d.primary} vs ${addrs[0].url}`);
    check('every address has a label', addrs.every((a) => !!a.label));
    check('every address has a URL', addrs.every((a) => /^http:\/\/.+\/$/.test(a.url)));
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
