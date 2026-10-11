'use strict';
/**
 * HwMonitor HTTP server.
 *
 * Serves a single-page dashboard plus a small JSON API and an SSE stream.
 * Zero third-party dependencies: node:http only, so nothing needs installing on
 * a low-power machine.
 *
 * Endpoints:
 *   GET  /                     dashboard (login page when a password is set)
 *   GET  /api/state            everything the dashboard needs, in one payload
 *   GET  /api/hardware         static inventory (cached)
 *   GET  /api/series           in-memory history for charts
 *   GET  /api/dsh              DSH usage report
 *   GET  /api/stream           SSE: pushed samples and DSH updates
 *   GET  /api/config           current config (password redacted)
 *   POST /api/config           update config (requires auth)
 *   POST /api/login            exchange password for a session cookie
 *   POST /api/logout           clear the session cookie
 *   POST /api/dsh/rescan       force a full re-read of DSH logs
 *   GET  /healthz              unauthenticated liveness probe
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

const { Config, ratesFor, ROOT } = require('./lib/config');
const { Collector } = require('./lib/collector');
const { DshAnalyzer } = require('./lib/dsh');
const labels = require('./lib/labels');
const services = require('./lib/services');
const { TerminalManager } = require('./lib/terminal');
const { SshManager } = require('./lib/ssh');

const PUBLIC_DIR = path.join(ROOT, 'public');
const INVENTORY_SCRIPT = path.join(ROOT, 'ps', 'inventory.ps1');
const INVENTORY_CACHE = path.join(ROOT, 'data', 'inventory.json');
const DATA_DIR = path.join(ROOT, 'data');
/**
 * PID file written on startup and removed on clean exit.
 *
 * The launcher uses this to identify *its own* previously started process when
 * cleaning up after a crash. Matching on command-line keywords instead would be
 * dangerous: a launcher invoked with the project path in its own command line
 * would match itself and terminate its own shell.
 */
const PID_FILE = path.join(DATA_DIR, 'server.pid');

const cfg = new Config();
const collector = new Collector({
  intervalMs: cfg.get('refreshMs'),
  historyMinutes: cfg.get('historyMinutes'),
});
const dsh = new DshAnalyzer();

function writePidFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        port: cfg.get('port'),
        node: process.execPath,
        cwd: process.cwd(),
      }, null, 2),
      'utf8'
    );
  } catch (e) {
    console.error(`[hwmonitor] could not write pid file: ${e.message}`);
  }
}

function removePidFile() {
  try {
    // Only remove the file if it still refers to this process, so a newer
    // instance's pid file is never deleted by an older one shutting down.
    const raw = fs.readFileSync(PID_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch {}
}

/**
 * Terminal sessions for the in-browser PowerShell.
 *
 * A web shell is remote code execution by design. This server is reachable from
 * the internet through the frp tunnel, so the terminal is refused outright unless
 * an access password is configured (see TerminalManager.isEnabled). Failing closed
 * is deliberate: better to require a password than to quietly publish a shell.
 */
const terminals = new TerminalManager({ cwd: ROOT });

/**
 * SSH sessions for the remote terminal.
 *
 * Like the PowerShell terminal, this is remote command execution and is therefore
 * only available when an access password is configured (see terminalEnabled).
 */
const sshSessions = new SshManager();

/** True when the terminal feature may be used. */
function terminalEnabled() {
  return terminals.isEnabled(passwordRequired());
}

// ------------------------------------------------------------ saved SSH hosts
//
// Stored in data/ssh-hosts.json. Passwords are deliberately NOT saved: they are
// used for the connection only. Keys are referenced by path instead, which is the
// recommended way to authenticate.
const SSH_HOSTS_FILE = path.join(DATA_DIR, 'ssh-hosts.json');

function loadSshHosts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SSH_HOSTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSshHosts(hosts) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${SSH_HOSTS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(hosts, null, 2), 'utf8');
    fs.renameSync(tmp, SSH_HOSTS_FILE);
    return true;
  } catch {
    return false;
  }
}

/** Add or update a saved host (matched by id, else by user@host:port). */
function saveSshHost(host) {
  const hosts = loadSshHosts();
  const entry = {
    id: host.id || crypto.randomBytes(6).toString('hex'),
    name: String(host.name || '').trim(),
    host: String(host.host || '').trim(),
    port: Number(host.port) || 22,
    user: String(host.user || '').trim(),
    keyPath: host.keyPath ? String(host.keyPath) : '',
    savedAt: new Date().toISOString(),
  };
  if (!entry.host || !entry.user) return hosts;
  const idx = hosts.findIndex((h) => h.id === entry.id);
  if (idx >= 0) hosts[idx] = entry;
  else hosts.push(entry);
  writeSshHosts(hosts);
  return hosts;
}

function deleteSshHost(id) {
  const hosts = loadSshHosts().filter((h) => h.id !== id);
  writeSshHosts(hosts);
  return hosts;
}

/**
 * Start the background service-status poller.
 *
 * A full probe costs seconds on this machine (PowerShell cold start plus WMI), so
 * it must never run inside a request. The poller keeps a warm snapshot that the
 * API serves instantly.
 */
services.statusCache.start();

// Push service-status changes to connected clients so the Services tab updates
// without polling. Only a real change is broadcast, so an idle server sends
// nothing.
let lastServicesSignature = '';
setInterval(async () => {
  try {
    const all = await services.statusAllCached();
    if (!all) return;
    const sig = all.map((s) => `${s.key}:${s.running}:${s.pid}`).join('|');
    if (sig !== lastServicesSignature) {
      lastServicesSignature = sig;
      broadcast('services', { services: all });
    }
  } catch {}
}, 4000).unref();

/** Active login sessions: token -> {createdAt, ip} */
const sessions = new Map();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Connected SSE clients. */
const sseClients = new Set();

// ------------------------------------------------------------------ startup
console.log('[hwmonitor] starting');
console.log(`[hwmonitor] data dir: ${path.join(ROOT, 'data')}`);
console.log(`[hwmonitor] DSH sessions: ${dsh.root}`);

collector.on('hello', (h) => {
  console.log(`[hwmonitor] collector ready (pid ${h.pid}, interval ${h.intervalMs}ms)`);
  console.log(`[hwmonitor] capabilities: ${JSON.stringify(h.capabilities)}`);
  broadcast('hello', { static: h.static, batteryStatic: h.batteryStatic, capabilities: h.capabilities, intervalMs: h.intervalMs });
});
collector.on('sample', (s) => broadcast('sample', s));
collector.on('error', (msg) => {
  console.error(`[hwmonitor] collector error: ${msg}`);
  broadcast('collector-error', { message: msg });
});
collector.on('restarting', (info) => {
  console.log(`[hwmonitor] collector restarting in ${info.delay}ms (restart #${info.restarts})`);
});

collector.start();

// Initial DSH scan. This is the only expensive scan (a few seconds for a large
// history); later scans read only appended bytes.
setTimeout(() => {
  try {
    const ms = dsh.scan();
    console.log(`[hwmonitor] DSH initial scan: ${ms}ms, ${dsh.sessions.size} sessions`);
    broadcast('dsh', dsh.report(cfg.data, ratesFor));
  } catch (e) {
    console.error(`[hwmonitor] DSH scan failed: ${e.message}`);
  }
}, 100);

// Periodic DSH rescan, so the DSH panel updates without the user reloading.
// The report is large (tens of KB for a long history), so it is only broadcast
// when a session's state actually changed. Without this guard the full report
// was re-sent every poll, which is pure waste on a metered or slow link.
const DSH_POLL_MS = 5000;
setInterval(() => {
  try {
    const revBefore = dsh.revision;
    dsh.scan();
    if (dsh.revision !== revBefore) broadcast('dsh', dsh.report(cfg.data, ratesFor));
  } catch (e) {
    console.error(`[hwmonitor] DSH rescan failed: ${e.message}`);
  }
}, DSH_POLL_MS).unref();

// ---------------------------------------------------------------- inventory
let inventoryCache = null;
let inventoryLoading = false;

function loadInventoryFromDisk() {
  try {
    const raw = fs.readFileSync(INVENTORY_CACHE, 'utf8');
    inventoryCache = JSON.parse(raw);
  } catch {
    inventoryCache = null;
  }
}

function collectInventory(force) {
  return new Promise((resolve) => {
    if (inventoryCache && !force) return resolve(inventoryCache);
    if (inventoryLoading) return resolve(inventoryCache);
    inventoryLoading = true;
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INVENTORY_SCRIPT],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 120000 },
      (err, stdout) => {
        inventoryLoading = false;
        if (err) {
          console.error(`[hwmonitor] inventory failed: ${err.message}`);
          return resolve(inventoryCache);
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          inventoryCache = parsed;
          try {
            fs.mkdirSync(path.dirname(INVENTORY_CACHE), { recursive: true });
            fs.writeFileSync(INVENTORY_CACHE, JSON.stringify(parsed), 'utf8');
          } catch {}
          resolve(parsed);
        } catch (e) {
          console.error(`[hwmonitor] inventory parse failed: ${e.message}`);
          resolve(inventoryCache);
        }
      }
    );
  });
}

loadInventoryFromDisk();
// Refresh in the background at startup; it is slow, so it must not block serving.
setTimeout(() => { collectInventory(true).catch(() => {}); }, 500);

// -------------------------------------------------------------- auth helpers
function passwordRequired() {
  return !!(cfg.get('password') && String(cfg.get('password')).length > 0);
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!passwordRequired()) return true;
  const token = parseCookies(req).hwm_session;
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}

/**
 * Constant-time password comparison. Both sides are hashed first so the
 * comparison length never leaks the real password's length.
 */
function passwordMatches(supplied) {
  const expected = String(cfg.get('password') || '');
  if (!expected) return true;
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------- SSE plumbing
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// -------------------------------------------------------------- http helpers
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serveStatic(res, urlPath) {
  // Resolve inside PUBLIC_DIR only; reject traversal attempts.
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  serveStaticFrom(res, full);
}

/**
 * Stream a single known file. Callers are responsible for having validated the
 * path; this helper only handles stat, headers and streaming.
 */
function serveStaticFrom(res, full) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(full).pipe(res);
  });
}

// ------------------------------------------------------- network addresses
/**
 * Addresses this server can be reached on.
 *
 * Windows machines commonly have several adapters, and the naive approach (list
 * every non-internal IPv4 address) surfaces useless entries: Hyper-V, WSL,
 * VirtualBox and VPN adapters all have addresses that no phone on the Wi-Fi can
 * reach. Those are therefore classified and de-prioritised, and the address that
 * actually works is marked as the primary one.
 *
 * Adapter details come from a single PowerShell call, since Node's
 * os.networkInterfaces() reports addresses but not which adapter or its state.
 */
async function buildAddresses() {
  const port = cfg.get('port');
  const host = cfg.get('host');

  // Which adapters exist, and which are up.
  let adapters = [];
  try {
    const out = await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-NetIPAddress -AddressFamily IPv4 | Select-Object IPAddress,InterfaceAlias,PrefixOrigin | ConvertTo-Json -Compress',
      ], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '').trim()));
    });
    if (out) {
      const parsed = JSON.parse(out);
      adapters = (Array.isArray(parsed) ? parsed : [parsed]).map((a) => ({
        ip: String(a.IPAddress || ''),
        name: String(a.InterfaceAlias || ''),
      }));
    }
  } catch {}

  // Fall back to Node's own view if PowerShell is unavailable.
  if (!adapters.length) {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const n of list || []) {
        if (n.family === 'IPv4') adapters.push({ ip: n.address, name });
      }
    }
  }

  /**
   * Classify an adapter by name. Virtual adapters get a low rank so a real Wi-Fi
   * or Ethernet address is offered first.
   */
  function classify(name) {
    const n = name.toLowerCase();
    if (/wi-?fi|wlan|无线/.test(n)) return { kind: 'wifi', rank: 0, label: 'Wi-Fi' };
    if (/ethernet|以太网|本地连接/.test(n)) return { kind: 'ethernet', rank: 1, label: '以太网' };
    if (/vethernet|hyper-v|wsl|docker|virtualbox|vmware|vmnet/.test(n)) {
      return { kind: 'virtual', rank: 90, label: '虚拟网卡' };
    }
    if (/vpn|tap|tun|wireguard|zerotier|tailscale|radmin|hamachi/.test(n)) {
      return { kind: 'vpn', rank: 80, label: 'VPN / 虚拟专网' };
    }
    if (/bluetooth|蓝牙/.test(n)) return { kind: 'bluetooth', rank: 95, label: '蓝牙' };
    return { kind: 'other', rank: 50, label: '其他' };
  }

  const entries = [];
  for (const a of adapters) {
    const ip = a.ip;
    if (!ip) continue;
    // Skip loopback and link-local (169.254.x.x, assigned when DHCP fails).
    if (ip.startsWith('127.')) continue;
    if (ip.startsWith('169.254.')) continue;
    const c = classify(a.name);
    entries.push({
      ip,
      adapter: a.name,
      kind: c.kind,
      label: c.label,
      rank: c.rank,
      url: `http://${ip}:${port}/`,
    });
  }

  // Best first: real adapters before virtual ones.
  entries.sort((a, b) => a.rank - b.rank || a.ip.localeCompare(b.ip));

  const primary = entries.length ? entries[0] : null;

  return {
    port,
    host,
    listeningOnAll: host === '0.0.0.0',
    primary: primary ? primary.url : null,
    local: `http://127.0.0.1:${port}/`,
    addresses: entries,
    // Tunnels are listed here too, so every way in is in one place. They come
    // from configuration rather than code: a tunnel's address is specific to one
    // deployment and should not be published in a repository.
    tunnels: Array.isArray(cfg.get('tunnels')) ? cfg.get('tunnels') : [],
  };
}

// ------------------------------------------------------------- state payload
function buildState() {
  const inv = inventoryCache;
  return {
    now: Date.now(),
    host: {
      name: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      uptimeSeconds: Math.round(os.uptime()),
    },
    collector: collector.status(),
    services: services.statusCache.get() || [],
    neverStop: [...services.NEVER_STOP],
    hello: collector.hello
      ? {
          static: collector.hello.static,
          batteryStatic: collector.hello.batteryStatic,
          disks: collector.hello.disks,
          capabilities: collector.hello.capabilities,
          intervalMs: collector.hello.intervalMs,
        }
      : null,
    sample: collector.latest,
    inventory: inv,
    config: publicConfig(),
    thresholds: cfg.get('thresholds'),
  };
}

function publicConfig() {
  return {
    port: cfg.get('port'),
    refreshMs: cfg.get('refreshMs'),
    historyMinutes: cfg.get('historyMinutes'),
    thresholds: cfg.get('thresholds'),
    pricing: cfg.get('pricing'),
    passwordSet: passwordRequired(),
  };
}

// ------------------------------------------------------------------ routing
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const p = url.pathname;

  // Unauthenticated liveness probe.
  if (p === '/healthz') {
    return sendJson(res, 200, {
      ok: true,
      collector: collector.isHealthy(),
      dshSessions: dsh.sessions.size,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }

  if (p === '/api/login') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid body' });
    }
    if (!passwordMatches(body.password)) {
      // Small delay blunts trivial brute force without a rate-limit table.
      await new Promise((r) => setTimeout(r, 600));
      return sendJson(res, 401, { error: '密码错误' });
    }
    pruneSessions();
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { createdAt: Date.now(), ip: req.socket.remoteAddress });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `hwm_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (p === '/api/logout') {
    const token = parseCookies(req).hwm_session;
    if (token) sessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'hwm_session=; Path=/; HttpOnly; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Everything below requires auth when a password is configured.
  const authed = isAuthed(req);

  // The SSE endpoint must be handled before the generic /api/ branch below,
  // which terminates with a 404 for anything it does not explicitly match.
  if (p === '/api/stream') {
    if (!authed) return sendJson(res, 401, { error: 'unauthorized' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    // Prime the client with current state so it renders immediately.
    res.write(`event: hello\ndata: ${JSON.stringify(buildState())}\n\n`);

    sseClients.add(res);
    // Comment frames keep proxies and the browser from timing the stream out.
    const keepalive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepalive);
        sseClients.delete(res);
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
    return;
  }

  if (p.startsWith('/api/')) {
    if (!authed) return sendJson(res, 401, { error: 'unauthorized', passwordRequired: true });

    if (p === '/api/state') return sendJson(res, 200, buildState());
    if (p === '/api/hardware') return sendJson(res, 200, inventoryCache || { pending: true });
    if (p === '/api/series') return sendJson(res, 200, { series: collector.series(), intervalMs: collector.intervalMs });
    if (p === '/api/dsh') return sendJson(res, 200, dsh.report(cfg.data, ratesFor));

    // Shared display strings, served from the same file the native GUI requires.
    // Keeping one definition prevents the two front ends from drifting apart.
    if (p === '/api/labels') return sendJson(res, 200, labels);

    if (p === '/api/config') {
      if (req.method === 'GET') return sendJson(res, 200, publicConfig());
      if (req.method === 'POST') {
        let patch;
        try {
          patch = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { error: 'invalid body' });
        }
        applyConfigPatch(patch);
        return sendJson(res, 200, publicConfig());
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (p === '/api/dsh/rescan' && req.method === 'POST') {
      const ms = dsh.scan({ full: true });
      const rep = dsh.report(cfg.data, ratesFor);
      broadcast('dsh', rep);
      return sendJson(res, 200, { ok: true, scanMs: ms, report: rep });
    }

    if (p === '/api/hardware/refresh' && req.method === 'POST') {
      const inv = await collectInventory(true);
      return sendJson(res, 200, inv || { pending: true });
    }

    // ------------------------------------------------------ network addresses
    // The addresses this server is reachable on, so they can be read off a phone
    // or copied without hunting through Windows network settings.
    if (p === '/api/addresses') {
      return sendJson(res, 200, await buildAddresses());
    }

    // ------------------------------------------------------ service control
    if (p === '/api/services') {
      const all = await services.statusAll();
      return sendJson(res, 200, {
        services: all,
        neverStop: [...services.NEVER_STOP],
        dshProtected: services.isNeverStop('dsh'),
      });
    }

    if (p === '/api/services/action' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: 'invalid body' });
      }
      const action = String(body.action || '').toLowerCase();
      const key = body.service ? String(body.service).toLowerCase() : null;

      if (!['start', 'stop', 'restart'].includes(action)) {
        return sendJson(res, 400, { error: 'action 必须是 start/stop/restart' });
      }
      if (key && !services.SERVICES[key]) {
        return sendJson(res, 400, { error: `未知服务: ${key}` });
      }

      // The policy guard also lives in services.stop(), but rejecting here gives
      // the UI a clear, immediate answer instead of a no-op result.
      if (key && (action === 'stop' || action === 'restart') && services.isNeverStop(key)) {
        return sendJson(res, 403, {
          error: `${services.SERVICES[key].name} 受保护，本工具不会停止或重启它（只允许手动关闭）`,
          protected: true,
          service: key,
        });
      }

      try {
        let result;
        if (action === 'start') {
          result = key ? await services.start(key) : await services.startAll();
        } else if (action === 'stop') {
          result = key ? await services.stop(key) : await services.stopAll();
        } else {
          // restart
          if (key) {
            await services.stop(key);
            await new Promise((r) => setTimeout(r, 1500));
            result = await services.start(key);
          } else {
            await services.stopAll();
            await new Promise((r) => setTimeout(r, 1500));
            result = await services.startAll();
          }
        }
        const all = await services.statusAll();
        broadcast('services', { services: all });
        return sendJson(res, 200, { ok: true, action, service: key, result, services: all });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ------------------------------------------------------ web terminal
    if (p === '/api/terminal/info') {
      return sendJson(res, 200, {
        enabled: terminalEnabled(),
        reason: terminalEnabled()
          ? null
          : '为安全起见，未设置访问口令时终端不可用。请在「设置」中设置口令后重试。',
        sessions: terminals.list(),
        cwd: ROOT,
      });
    }

    if (p === '/api/terminal/open' && req.method === 'POST') {
      if (!terminalEnabled()) {
        return sendJson(res, 403, {
          error: '终端已禁用：请先在「设置」中设置访问口令。',
          code: 'terminal-disabled',
        });
      }
      const s = terminals.create();
      return sendJson(res, 200, { ok: true, session: s.info() });
    }

    if (p === '/api/terminal/close' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid body' }); }
      const ok = terminals.destroy(String(body.session || ''));
      return sendJson(res, 200, { ok });
    }

    if (p === '/api/terminal/run' && req.method === 'POST') {
      if (!terminalEnabled()) {
        return sendJson(res, 403, { error: '终端已禁用', code: 'terminal-disabled' });
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid body' }); }
      const s = terminals.get(String(body.session || ''));
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      const command = String(body.command || '');
      if (!command.trim()) return sendJson(res, 400, { error: '命令为空' });
      const r = s.run(command);
      return sendJson(res, r.ok ? 200 : 409, r);
    }

    if (p === '/api/terminal/interrupt' && req.method === 'POST') {
      if (!terminalEnabled()) return sendJson(res, 403, { error: '终端已禁用' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid body' }); }
      const s = terminals.get(String(body.session || ''));
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      const ok = s.interrupt();
      return sendJson(res, 200, { ok });
    }

    // Server-sent stream of terminal output for one session.
    if (p === '/api/terminal/stream') {
      if (!terminalEnabled()) return sendJson(res, 403, { error: '终端已禁用' });
      const sessionId = url.searchParams.get('session') || '';
      const s = terminals.get(sessionId);
      if (!s) return sendJson(res, 404, { error: '会话不存在' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      res.write(`event: info\ndata: ${JSON.stringify(s.info())}\n\n`);

      // Replay recent scrollback so a reconnecting client sees context.
      for (const e of s.scrollback.slice(-80)) {
        res.write(`event: output\ndata: ${JSON.stringify(e)}\n\n`);
      }

      const onOutput = (e) => {
        try { res.write(`event: output\ndata: ${JSON.stringify(e)}\n\n`); } catch {}
      };
      const onDone = (e) => {
        try { res.write(`event: done\ndata: ${JSON.stringify(e)}\n\n`); } catch {}
      };
      const onTimeout = (e) => {
        try { res.write(`event: timeout\ndata: ${JSON.stringify(e)}\n\n`); } catch {}
      };
      const onExit = (e) => {
        try { res.write(`event: exit\ndata: ${JSON.stringify(e)}\n\n`); } catch {}
      };

      s.on('output', onOutput);
      s.on('command-done', onDone);
      s.on('command-timeout', onTimeout);
      s.on('exit', onExit);

      const keepalive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 20000);

      req.on('close', () => {
        clearInterval(keepalive);
        s.off('output', onOutput);
        s.off('command-done', onDone);
        s.off('command-timeout', onTimeout);
        s.off('exit', onExit);
      });
      return;
    }

    // ------------------------------------------------------------- SSH
    // Remote command execution, gated on the same password policy as the local
    // terminal. Credentials are used for the connection only and are never
    // persisted; see lib/ssh.js for how the password is kept off the command line.
    if (p === '/api/ssh/hosts' && req.method === 'GET') {
      // Saved hosts plus the local SSH identity that is available for key auth.
      const keyDir = path.join(os.homedir(), '.ssh');
      let keys = [];
      try {
        keys = fs.readdirSync(keyDir)
          .filter((f) => !f.endsWith('.pub') && !['known_hosts', 'config', 'authorized_keys'].includes(f))
          .map((f) => ({ name: f, path: path.join(keyDir, f) }));
      } catch {}
      return sendJson(res, 200, { hosts: loadSshHosts(), keys, enabled: terminalEnabled() });
    }

    if (p === '/api/ssh/hosts' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid body' }); }
      const saved = saveSshHost(body.host || {});
      return sendJson(res, 200, { ok: true, hosts: saved });
    }

    if (p === '/api/ssh/hosts/delete' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid body' }); }
      const saved = deleteSshHost(String(body.id || ''));
      return sendJson(res, 200, { ok: true, hosts: saved });
    }

    if (p === '/api/ssh/open' && req.method === 'POST') {
      if (!terminalEnabled()) {
        return sendJson(res, 403, { error: 'SSH 已禁用：请先在「设置」中设置访问口令。', code: 'terminal-disabled' });
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid body' }); }

      const host = String(body.host || '').trim();
      const user = String(body.user || '').trim();
      if (!host) return sendJson(res, 400, { error: '请填写主机地址' });
      if (!user) return sendJson(res, 400, { error: '请填写用户名' });

      const s = sshSessions.create({
        host,
        port: Number(body.port) || 22,
        user,
        password: body.password ? String(body.password) : '',
        keyPath: body.keyPath ? String(body.keyPath) : '',
        acceptNewHostKey: body.acceptNewHostKey !== false,
      });
      return sendJson(res, 200, { ok: true, session: s.info() });
    }

    if (p === '/api/ssh/close' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid body' }); }
      const ok = sshSessions.destroy(String(body.session || ''));
      return sendJson(res, 200, { ok });
    }

    if (p === '/api/ssh/run' && req.method === 'POST') {
      if (!terminalEnabled()) return sendJson(res, 403, { error: 'SSH 已禁用', code: 'terminal-disabled' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid body' }); }
      const s = sshSessions.get(String(body.session || ''));
      if (!s) return sendJson(res, 404, { error: 'SSH 会话不存在' });
      const command = String(body.command || '');
      if (!command.trim()) return sendJson(res, 400, { error: '命令为空' });
      const r = s.run(command);
      return sendJson(res, r.ok ? 200 : 409, r);
    }

    if (p === '/api/ssh/stream') {
      if (!terminalEnabled()) return sendJson(res, 403, { error: 'SSH 已禁用' });
      const sessionId = url.searchParams.get('session') || '';
      const s = sshSessions.get(sessionId);
      if (!s) return sendJson(res, 404, { error: 'SSH 会话不存在' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      res.write(`event: info\ndata: ${JSON.stringify(s.info())}\n\n`);
      for (const e of s.scrollback.slice(-80)) {
        res.write(`event: output\ndata: ${JSON.stringify(e)}\n\n`);
      }

      const onOutput = (e) => { try { res.write(`event: output\ndata: ${JSON.stringify(e)}\n\n`); } catch {} };
      const onDone = (e) => { try { res.write(`event: done\ndata: ${JSON.stringify(e)}\n\n`); } catch {} };
      const onTimeout = (e) => { try { res.write(`event: timeout\ndata: ${JSON.stringify(e)}\n\n`); } catch {} };
      const onExit = (e) => { try { res.write(`event: exit\ndata: ${JSON.stringify(e)}\n\n`); } catch {} };

      s.on('output', onOutput);
      s.on('command-done', onDone);
      s.on('command-timeout', onTimeout);
      s.on('exit', onExit);

      const keepalive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 20000);

      req.on('close', () => {
        clearInterval(keepalive);
        s.off('output', onOutput);
        s.off('command-done', onDone);
        s.off('command-timeout', onTimeout);
        s.off('exit', onExit);
      });
      return;
    }

    return sendJson(res, 404, { error: 'unknown endpoint' });
  }

  // Serve the shared labels module to the browser as a plain script. It is the
  // exact file the native GUI requires, so wording cannot drift between the two
  // front ends. Served from lib/ rather than duplicated into public/.
  //
  // Note this is served WITHOUT authentication, like the other static assets: the
  // login page itself needs app.js and styles.css to render, so gating static
  // files behind auth makes the page unusable (it was previously answered with
  // index.html for every asset, which is why the dashboard rendered as unstyled
  // text). The file contains only display strings and no user data.
  if (p === '/labels.js') {
    return serveStaticFrom(res, path.join(ROOT, 'lib', 'labels.js'));
  }

  // Static assets must load before login: the login form is part of the same
  // page and is styled and driven by these files. Only API routes require auth.
  // Nothing under public/ contains user data.
  serveStatic(res, p);
});

/**
 * Apply a config patch from the UI, restarting the collector if the sampling
 * interval changed (the interval is passed to the child via env).
 */
function applyConfigPatch(patch) {
  const prevInterval = collector.intervalMs;
  const prevPort = cfg.get('port');

  if (patch && typeof patch.password === 'string') {
    // An empty string clears the password requirement.
    patch.password = patch.password.trim();
  }
  cfg.update(patch);

  const nextInterval = cfg.get('refreshMs');
  if (nextInterval !== prevInterval) {
    console.log(`[hwmonitor] refresh interval ${prevInterval}ms -> ${nextInterval}ms; restarting collector`);
    collector.intervalMs = nextInterval;
    collector.historyMinutes = cfg.get('historyMinutes');
    collector.stop();
    setTimeout(() => collector.start(), 300);
  } else {
    collector.historyMinutes = cfg.get('historyMinutes');
  }

  if (cfg.get('port') !== prevPort) {
    console.log(`[hwmonitor] port change to ${cfg.get('port')} requires a restart`);
  }
}

// ------------------------------------------------------------------ startup
const port = cfg.get('port');
const host = cfg.get('host');
writePidFile();
server.listen(port, host, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
    }
  }
  console.log('');
  console.log('  HwMonitor 已启动');
  console.log(`  本机访问:   http://127.0.0.1:${port}`);
  for (const ip of lan) console.log(`  局域网访问: http://${ip}:${port}`);
  if (passwordRequired()) {
    console.log('  访问口令:   已启用');
  } else {
    console.log('  访问口令:   未设置 (局域网内任何人可访问，建议在页面上设置口令)');
  }
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[hwmonitor] 端口 ${port} 已被占用。请修改 data/config.json 中的 port 后重启。`);
  } else {
    console.error(`[hwmonitor] server error: ${err.message}`);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n[hwmonitor] ${signal} received, shutting down`);
  collector.stop();
  terminals.disposeAll();
  services.statusCache.stop();
  removePidFile();
  for (const res of sseClients) {
    try { res.end(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * A monitoring server must not die because one probe failed.
 *
 * An earlier version called process.exit(1) here, so a single unexpected error
 * (for example `spawn EROFS` from a status probe) terminated the whole server.
 * The browser would then keep its already-loaded HTML but fail to fetch CSS and
 * JS, which is exactly the "page shows only text" symptom, and the services panel
 * would appear to reset at random.
 *
 * Uncaught errors are therefore logged and swallowed: the affected request fails,
 * the rest of the dashboard keeps working, and the process stays up.
 */
process.on('uncaughtException', (err) => {
  console.error(`[hwmonitor] uncaught exception (server kept running): ${err && err.stack ? err.stack : err}`);
  // Do not remove the pid file: this process is still alive and still owns it.
});

process.on('unhandledRejection', (reason) => {
  console.error(`[hwmonitor] unhandled rejection (server kept running): ${reason && reason.stack ? reason.stack : reason}`);
});

// The pid file is removed only on a real exit, never on a recovered error.
process.on('exit', () => removePidFile());
