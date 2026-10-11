// End-to-end check of the web UI with a password configured.
//
// Verifies the three symptoms that were reported:
//   1. The page rendered as unstyled text  -> assets must return correct MIME types
//   2. Responses were extremely slow       -> API latency must be low
//   3. The services panel was incomplete   -> the services payload must be complete
//
// Reads the password from data/config.json so the test exercises the real setup.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = { host: '127.0.0.1', port: 8080 };
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const PASSWORD = cfg.password || '';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

function request(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const t = Date.now();
    const req = http.request({
      ...BASE, path: urlPath, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      timeout: 45000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        ms: Date.now() - t,
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: Buffer.alloc(0), ms: Date.now() - t, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), ms: Date.now() - t, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('=== 1. assets load with correct MIME types (fixes "plain text" page) ===');
  const home = await request('GET', '/');
  check('index.html is text/html', /text\/html/.test(home.headers['content-type'] || ''),
    home.headers['content-type']);

  const css = await request('GET', '/styles.css');
  check('styles.css is text/css', /text\/css/.test(css.headers['content-type'] || ''),
    `${css.headers['content-type']} ${css.body.length}B`);
  check('styles.css has real content', css.body.length > 5000, `${css.body.length} bytes`);

  const js = await request('GET', '/app.js');
  check('app.js is javascript', /javascript/.test(js.headers['content-type'] || ''),
    `${js.headers['content-type']} ${js.body.length}B`);
  check('app.js has real content', js.body.length > 10000, `${js.body.length} bytes`);

  const labels = await request('GET', '/labels.js');
  check('labels.js is javascript', /javascript/.test(labels.headers['content-type'] || ''));
  check('labels.js exposes HWM_LABELS', /window\.HWM_LABELS/.test(labels.body.toString('utf8')));

  console.log('\n=== 2. API is protected and fast ===');
  const unauth = await request('GET', '/api/state');
  check('unauthenticated API returns 401', unauth.status === 401, `status ${unauth.status}`);

  const login = await request('POST', '/api/login', { body: { password: PASSWORD } });
  check('login succeeds with the configured password', login.status === 200, `status ${login.status}`);
  const setCookie = login.headers['set-cookie'];
  check('session cookie issued', Array.isArray(setCookie) && /hwm_session=/.test(setCookie[0]));
  const cookie = setCookie ? setCookie[0].split(';')[0] : '';

  const state = await request('GET', '/api/state', { cookie });
  check('authenticated /api/state returns 200', state.status === 200, `status ${state.status}`);
  check('/api/state is fast (< 1500ms)', state.ms < 1500, `${state.ms}ms`);

  console.log('\n=== 3. services payload is complete ===');
  const svc = await request('GET', '/api/services', { cookie });
  check('/api/services returns 200', svc.status === 200, `status ${svc.status}`);
  check('/api/services is fast (< 2000ms)', svc.ms < 2000, `${svc.ms}ms`);

  let svcData = null;
  try { svcData = JSON.parse(svc.body.toString('utf8')); } catch {}
  check('services payload parses', !!svcData);
  if (svcData) {
    check('three services reported', (svcData.services || []).length === 3,
      `${(svcData.services || []).length}`);
    for (const s of svcData.services || []) {
      console.log(`      ${s.name.padEnd(11)} running=${s.running} pid=${s.pid} ports=${(s.ports || []).map((p) => p.port + (p.open ? '✓' : '✗')).join(',') || '—'}`);
    }
    const names = (svcData.services || []).map((s) => s.key).sort();
    check('all three keys present', names.join(',') === 'dsh,frpc,hwmonitor', names.join(','));
  }

  console.log('\n=== 4. state includes services for first paint ===');
  let stData = null;
  try { stData = JSON.parse(state.body.toString('utf8')); } catch {}
  check('state.services present', !!(stData && Array.isArray(stData.services) && stData.services.length));
  check('state.neverStop present', !!(stData && Array.isArray(stData.neverStop)));

  console.log('\n=== 5. terminal availability reflects password policy ===');
  const term = await request('GET', '/api/terminal/info', { cookie });
  let termData = null;
  try { termData = JSON.parse(term.body.toString('utf8')); } catch {}
  check('terminal info returns 200', term.status === 200);
  check('terminal enabled because a password is set', !!(termData && termData.enabled),
    termData ? `enabled=${termData.enabled}` : '');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
