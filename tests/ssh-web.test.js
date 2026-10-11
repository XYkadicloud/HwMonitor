// End-to-end test of the web SSH feature over the real HTTP API.
//
// Connects to the machine's own SSH server using the user's key, runs commands,
// and verifies the SSE stream delivers output. Non-destructive: read-only
// commands only.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Collect SSE events from the SSH stream for a while. */
function collectStream(sessionId, cookie, ms) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.get({
      host: '127.0.0.1', port: 8080,
      path: `/api/ssh/stream?session=${encodeURIComponent(sessionId)}`,
      headers: { Cookie: cookie },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!block.trim() || block.startsWith(':')) continue;
          let name = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          let parsed = null;
          try { parsed = JSON.parse(data); } catch {}
          events.push({ name, parsed });
        }
      });
    });
    setTimeout(() => { req.destroy(); resolve(events); }, ms);
  });
}

(async () => {
  console.log('=== login ===');
  const login = await request('POST', '/api/login', { body: { password: cfg.password } });
  check('login ok', login.status === 200, `status ${login.status}`);
  const cookie = (login.headers['set-cookie'] || [''])[0].split(';')[0];
  check('cookie issued', !!cookie);

  console.log('\n=== host list ===');
  const hosts = await request('GET', '/api/ssh/hosts', { cookie });
  check('host list ok', hosts.status === 200);
  const hostData = JSON.parse(hosts.body);
  check('ssh enabled (password is set)', hostData.enabled === true);
  check('local key discovered', (hostData.keys || []).length > 0,
    (hostData.keys || []).map((k) => k.name).join(', '));

  console.log('\n=== open a session to localhost with the key ===');
  const keyPath = (hostData.keys || []).find((k) => k.name === 'id_ed25519');
  const open = await request('POST', '/api/ssh/open', {
    cookie,
    body: {
      host: '127.0.0.1',
      port: 22,
      user: process.env.USERNAME,
      keyPath: keyPath ? keyPath.path : '',
    },
  });
  check('session opened', open.status === 200, open.body.slice(0, 160));
  let session = null;
  try { session = JSON.parse(open.body).session; } catch {}
  check('session info returned', !!session);
  if (!session) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`      id=${session.id} auth=${session.authMode} stateful=${session.stateful}`);
  check('auth mode is key', session.authMode === 'key', session.authMode);
  check('statefulness reported as false', session.stateful === false);

  console.log('\n=== stream + run a command ===');
  const streamPromise = collectStream(session.id, cookie, 14000);
  await sleep(2500); // let the stream attach

  const run = await request('POST', '/api/ssh/run', {
    cookie,
    body: { session: session.id, command: 'echo WEB_SSH_MARKER' },
  });
  check('run accepted', run.status === 200, run.body.slice(0, 160));

  const events = await streamPromise;
  const output = events.filter((e) => e.name === 'output').map((e) => e.parsed.text).join('');
  const doneEvents = events.filter((e) => e.name === 'done');

  console.log(`      events: ${events.length}, done: ${doneEvents.length}`);
  check('output streamed', /WEB_SSH_MARKER/.test(output),
    output.replace(/\s+/g, ' ').slice(0, 160));
  check('done event received', doneEvents.length >= 1, `${doneEvents.length}`);
  check('no escape sequences leaked', !/\u001b/.test(output));

  console.log('\n=== unauthenticated access is refused ===');
  const noAuth = await request('POST', '/api/ssh/run', {
    body: { session: session.id, command: 'echo SHOULD_NOT_RUN' },
  });
  check('run without cookie returns 401', noAuth.status === 401, `status ${noAuth.status}`);

  const noAuthOpen = await request('POST', '/api/ssh/open', {
    body: { host: '127.0.0.1', user: 'x' },
  });
  check('open without cookie returns 401', noAuthOpen.status === 401, `status ${noAuthOpen.status}`);

  console.log('\n=== validation ===');
  const badOpen = await request('POST', '/api/ssh/open', {
    cookie, body: { host: '', user: '' },
  });
  check('missing host/user rejected', badOpen.status === 400, badOpen.body.slice(0, 100));

  const badRun = await request('POST', '/api/ssh/run', {
    cookie, body: { session: 'nonexistent', command: 'ls' },
  });
  check('unknown session returns 404', badRun.status === 404, `status ${badRun.status}`);

  console.log('\n=== cleanup ===');
  const close = await request('POST', '/api/ssh/close', {
    cookie, body: { session: session.id },
  });
  check('session closed', close.status === 200);

  const runAfter = await request('POST', '/api/ssh/run', {
    cookie, body: { session: session.id, command: 'echo AFTER' },
  });
  check('run on closed session returns 404', runAfter.status === 404, `status ${runAfter.status}`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
