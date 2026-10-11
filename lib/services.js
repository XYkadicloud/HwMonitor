'use strict';
/**
 * Service manager for the three things this machine runs:
 *
 *   1. HwMonitor  - this project's web server (node server.js, port 8080)
 *   2. DSH        - DeepSeek Harness web UI (dsh web, ports 3080 and 3082)
 *   3. FRPC       - the frp tunnel that exposes both to the internet
 *
 * Process identification strategy
 * ------------------------------
 * Every service is identified by a combination of (a) a PID file written by the
 * service itself, and (b) a verification of the candidate process's command line
 * against an expected pattern. Keyword matching alone is never used to *find*
 * processes to kill: a shell whose own command line happens to contain the
 * project path (which is exactly what happens when a command is run through a
 * wrapper) would otherwise match itself and be terminated. That mistake was made
 * twice during development and killed the server, so it is designed out here.
 *
 * Ports are used only as a cross-check and as a fallback discovery mechanism.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PID_DIR = path.join(DATA_DIR, 'pids');

/** Directory holding the FRPC installation, discovered relative to this repo. */
const FRPC_DIR = path.join(path.dirname(ROOT), 'FRPC');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a PowerShell snippet and return trimmed stdout.
 *
 * execFile can throw synchronously (observed: `spawn EROFS` when the process
 * inherits a restricted sandbox from its launcher). That exception previously
 * escaped this helper, propagated through statusAll() into an async request
 * handler and took the whole web server down. Every failure mode is therefore
 * caught here and reported as empty output, so a broken probe degrades the
 * feature instead of killing the process.
 */
function ps(script, timeout = 30000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) {
            lastProbeError = err.message || String(err);
            resolve('');
            return;
          }
          resolve(String(stdout || '').trim());
        }
      );
    } catch (e) {
      // Synchronous spawn failure (EROFS, EPERM, ENOENT ...).
      lastProbeError = e.message || String(e);
      resolve('');
      return;
    }
    // Guard against an 'error' event with no callback (also possible on EROFS).
    if (child && typeof child.on === 'function') {
      child.on('error', (e) => {
        lastProbeError = e.message || String(e);
        resolve('');
      });
    }
  });
}

/**
 * Last error seen by ps(), exposed so the UI can explain why service status is
 * unavailable instead of silently showing everything as stopped.
 */
let lastProbeError = null;

function probeError() {
  return lastProbeError;
}

/**
 * PIDs that must never be terminated: this process and every ancestor.
 *
 * The manager is normally driven from inside a DSH session, which means the DSH
 * host process is an ancestor of this process. Killing DSH would tear down the
 * very session that issued the command (observed: ECONNRESET and a session
 * restart). Computing the protected set once, up front, makes that impossible.
 */
const PROTECTED_PIDS = (function () {
  const set = new Set();
  set.add(process.pid);
  let pid = process.ppid;
  let hops = 0;
  while (Number.isFinite(pid) && pid > 0 && hops < 32) {
    set.add(pid);
    let parent = null;
    try {
      const out = require('child_process').execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 }
      ).trim();
      const n = Number(out);
      if (Number.isFinite(n) && n > 0 && n !== pid) parent = n;
    } catch {}
    if (parent === null || set.has(parent)) break;
    pid = parent;
    hops++;
  }
  return set;
})();

/** True when a PID must never be killed by this manager. */
function isProtected(pid) {
  return PROTECTED_PIDS.has(Number(pid));
}

/**
 * Services that must never be stopped by this tooling, regardless of how it was
 * launched.
 *
 * DSH is protected by default and unconditionally: this machine is often driven
 * remotely, and terminating DSH would end the session with no local way to bring
 * it back (it has to be restarted by hand at the keyboard). An ancestry-based
 * guard is not sufficient here, because the launchers are also run from desktop
 * shortcuts, where the DSH host is not an ancestor.
 *
 * The list is read from data/config.json so it can be changed deliberately
 * without editing code; the default (when the key is absent or unreadable) is to
 * protect DSH.
 */
function loadNeverStop() {
  const fallback = new Set(['dsh']);
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.safety && Array.isArray(cfg.safety.neverStop)) {
      return new Set(cfg.safety.neverStop.map((s) => String(s).toLowerCase()));
    }
  } catch {}
  return fallback;
}

const NEVER_STOP = loadNeverStop();

/** True when a service is policy-protected from being stopped. */
function isNeverStop(key) {
  return NEVER_STOP.has(String(key).toLowerCase());
}

/**
 * Query running processes with their command lines.
 * Returns [{pid, name, cmd, startedAt}]. One WMI call for all processes, which is
 * far cheaper than per-PID lookups.
 */
async function listProcesses() {
  const out = await ps(
    "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine," +
    "CreationDate | ConvertTo-Json -Compress -Depth 3",
    45000
  );
  if (!out) return [];
  let parsed;
  try { parsed = JSON.parse(out); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((p) => ({
    pid: Number(p.ProcessId),
    name: String(p.Name || ''),
    cmd: String(p.CommandLine || ''),
    startedAt: p.CreationDate || null,
  })).filter((p) => Number.isFinite(p.pid));
}

/**
 * Listening TCP ports, gathered for every port in a single PowerShell call.
 *
 * Per-port queries meant one process spawn per port (and the panel polls
 * frequently), which on this machine costs seconds per call and dominated the
 * whole UI's latency. One batched call is used instead.
 *
 * @param {number[]} ports
 * @returns {Promise<Map<number, number[]>>} port -> owning PIDs
 */
async function listeningPorts(ports) {
  const result = new Map();
  const wanted = ports.map(Number).filter((n) => Number.isFinite(n));
  for (const p of wanted) result.set(p, []);
  if (!wanted.length) return result;

  // netstat is used rather than Get-NetTCPConnection: it is markedly faster and
  // does not depend on the NetTCPIP module being available.
  const out = await ps('netstat -ano', 30000);
  if (!out) return result;

  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    // Columns: Proto, Local Address, Foreign Address, State, PID
    const local = cols[1] || '';
    const pid = Number(cols[cols.length - 1]);
    if (!Number.isFinite(pid)) continue;
    const m = /:(\d+)$/.exec(local);
    if (!m) continue;
    const port = Number(m[1]);
    if (result.has(port)) {
      const list = result.get(port);
      if (!list.includes(pid)) list.push(pid);
    }
  }
  return result;
}

/** PIDs listening on a TCP port. */
async function portHolders(port) {
  const map = await listeningPorts([Number(port)]);
  return map.get(Number(port)) || [];
}

/** Whether a TCP port currently has a listener. */
async function portOpen(port) {
  const holders = await portHolders(port);
  return holders.length > 0;
}

/** Terminate a process tree by PID. Returns true if the kill was issued. */
async function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 20000 },
      () => resolve(true));
  });
}

function ensurePidDir() {
  try { fs.mkdirSync(PID_DIR, { recursive: true }); } catch {}
}

function pidFilePath(key) {
  return path.join(PID_DIR, `${key}.pid`);
}

function writePid(key, info) {
  ensurePidDir();
  try {
    fs.writeFileSync(pidFilePath(key), JSON.stringify({
      ...info,
      writtenAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch {}
}

function readPid(key) {
  try {
    return JSON.parse(fs.readFileSync(pidFilePath(key), 'utf8'));
  } catch {
    return null;
  }
}

function clearPid(key) {
  try { fs.unlinkSync(pidFilePath(key)); } catch {}
}

/**
 * Whether a process record belongs to a given service definition.
 *
 * Both the process name and the command line must match. Requiring the name is
 * what prevents a wrapper shell (`cmd.exe`, `powershell.exe`) whose command line
 * happens to end with the service's own command text from being mistaken for the
 * service -- killing such a wrapper is what previously terminated the session
 * that issued the stop.
 *
 * @param {object} svc  service definition with `match` and optional `procName`
 * @param {{name: string, cmd: string}} proc
 */
function serviceMatches(svc, proc) {
  if (svc.procName && !svc.procName.test(String(proc.name || ''))) return false;
  return svc.match.test(String(proc.cmd || ''));
}

/** True when a process with this PID exists and still belongs to the service. */
function pidAlive(procs, pid, svc) {
  const p = procs.find((x) => x.pid === Number(pid));
  if (!p) return null;
  if (svc && !serviceMatches(svc, p)) return null;
  return p;
}

// --------------------------------------------------------------- definitions

/**
 * Service definitions.
 *
 * `match` is a regex tested against a candidate process's command line. It must
 * be specific enough that it cannot match a wrapper shell: note that DSH's own
 * runner command lines contain the DSH package path, so the pattern anchors on
 * the actual entry script.
 */
const SERVICES = {
  hwmonitor: {
    key: 'hwmonitor',
    name: 'HwMonitor',
    description: '硬件与 DSH 使用监控网页服务',
    ports: [8080],
    // server.js run from this project directory.
    // The process *name* must be node.exe and the command line must name this
    // project's server.js.
    //
    // Checking the name is what makes this safe. A wrapper shell such as
    // `cmd /c cd <dir> && node server.js` ends with the same text, but its
    // process name is cmd.exe, so it can never match. Matching on the command
    // line alone previously let such wrappers match themselves and be killed --
    // that is what terminated the session running the command.
    procName: /^node(\.exe)?$/i,
    // Allows the script argument to be bare (`server.js`), an absolute path, or a
    // quoted path, with either slash style. A bare path prefix is permitted
    // because Task Scheduler passes the full path unquoted when it contains no
    // spaces. The trailing boundary keeps `myserver.js` from matching.
    match: /(?:^|[\s"])(?:[A-Za-z]:[\\/])?(?:[^"\s]*[\\/])?server\.js"?\s*$/i,
    async start() {
      const node = process.execPath;
      const child = spawn(node, ['server.js'], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      writePid('hwmonitor', { pid: child.pid, kind: 'spawned' });
      return child.pid;
    },
  },

  dsh: {
    key: 'dsh',
    name: 'DSH',
    description: 'DeepSeek Harness 网页界面',
    ports: [3080, 3082],
    // The DSH entry script, launched either via `dsh web` or directly.
    // Process name must be node; the wrapper `dsh.cmd` shim is cmd.exe and must
    // not match (see the HwMonitor entry above for why).
    procName: /^node(\.exe)?$/i,
    match: /dsh[\\/]lib[\\/]bin\.js"?\s+web/i,
    async start() {
      // Invoke the DSH entry script directly with the Node executable, instead of
      // going through the `dsh.cmd` shim.
      //
      // Measured failure with the shim: `dsh.cmd` internally calls bare `node`,
      // and a process spawned from this service does not inherit a PATH that
      // contains the Node installation directory, so it fails with
      //   '"node"' is not recognized as an internal or external command
      // and DSH never starts. Using process.execPath (an absolute path) removes
      // the PATH dependency entirely.
      const bin = path.join(process.env.APPDATA || '', 'npm', 'node_modules',
        '@deepseek-ai', 'dsh', 'lib', 'bin.js');

      if (!fs.existsSync(bin)) {
        throw new Error(`找不到 DSH 入口脚本: ${bin}`);
      }

      const child = spawn(process.execPath, [bin, 'web'], {
        cwd: os.homedir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        // Pass a PATH that includes the Node directory so any helper DSH itself
        // spawns by name (it launches node children) can be resolved.
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)};${process.env.PATH || ''}`,
        },
      });
      child.unref();
      writePid('dsh', { pid: child.pid, kind: 'spawned' });
      return child.pid;
    },
  },

  frpc: {
    key: 'frpc',
    name: 'FRPC',
    description: '内网穿透（frp 客户端）',
    ports: [],
    // frpc resolves the -c argument to an absolute path, so the pattern must
    // allow an optional directory prefix before the config file name. Anchoring
    // on the config name keeps this from matching unrelated frpc invocations
    // that use a different tunnel set.
    procName: /^frpc(\.exe)?$/i,
    match: /frpc\.exe"?\s+-c\s+(?:\S*[\\/])?frpc_all\.toml/i,
    configFile: path.join(FRPC_DIR, 'frpc_all.toml'),
    async start() {
      const exe = path.join(FRPC_DIR, 'frpc.exe');
      const cfg = path.join(FRPC_DIR, 'frpc_all.toml');
      if (!fs.existsSync(exe)) throw new Error(`frpc.exe 不存在: ${exe}`);
      if (!fs.existsSync(cfg)) throw new Error(`frpc_all.toml 不存在: ${cfg}`);
      const child = spawn(exe, ['-c', cfg], {
        cwd: FRPC_DIR,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      writePid('frpc', { pid: child.pid, kind: 'spawned' });
      return child.pid;
    },
  },
};

/** All service keys in start order (dependencies first). */
const ORDER = ['hwmonitor', 'dsh', 'frpc'];

/**
 * Determine the live state of one service.
 *
 * @param {string} key
 * @param {Array} [procs]  pre-fetched process list (avoids a second WMI call)
 * @param {Map<number, number[]>} [ports] pre-fetched listening-port map
 * @returns {{key, name, description, running: boolean, pid: number|null,
 *            ports: Array<{port:number, open:boolean, pids:number[]}>, detail: string}}
 */
async function status(key, procs, ports) {
  const svc = SERVICES[key];
  if (!svc) throw new Error(`unknown service: ${key}`);
  const list = procs || (await listProcesses());
  const portMap = ports || (await listeningPorts(svc.ports));

  const portInfo = svc.ports.map((p) => {
    const holders = portMap.get(Number(p)) || [];
    return { port: p, open: holders.length > 0, pids: holders };
  });

  // Prefer the recorded PID, but verify it still matches the service.
  let pid = null;
  let detail = '';
  const rec = readPid(key);
  if (rec && rec.pid) {
    const p = pidAlive(list, rec.pid, svc);
    if (p) { pid = p.pid; detail = '来自 PID 记录'; }
    else { clearPid(key); detail = 'PID 记录已失效'; }
  }

  // Fall back to scanning for a matching process.
  if (pid === null) {
    const hits = list.filter((p) => serviceMatches(svc, p));
    if (hits.length) {
      // Prefer the oldest matching process: it is the parent/original instance.
      hits.sort((a, b) => a.pid - b.pid);
      pid = hits[0].pid;
      detail = hits.length > 1 ? `发现 ${hits.length} 个匹配进程` : '由命令行匹配';
    }
  }

  // FRPC has no listening port of its own, so presence of the process is the
  // signal. For the others, require a matching process *and* an open port.
  let running;
  if (svc.ports.length === 0) {
    running = pid !== null;
  } else {
    const anyPortOpen = portInfo.some((p) => p.open);
    running = pid !== null && anyPortOpen;
    if (pid !== null && !anyPortOpen) detail = '进程在但端口未监听（可能正在启动）';
    if (pid === null && anyPortOpen) detail = '端口被非本服务进程占用';
  }

  return {
    key,
    name: svc.name,
    description: svc.description,
    running,
    pid,
    ports: portInfo,
    detail,
  };
}

/**
 * One-shot probe returning both the process list and the listening-port map.
 *
 * Both facts are needed together for every status refresh, and on this machine a
 * single PowerShell cold start costs several seconds. Combining them into one
 * spawn halves the cost; see StatusCache for how the remaining cost is kept off
 * the request path entirely.
 *
 * @returns {Promise<{procs: Array, ports: Map<number, number[]>}>}
 */
async function probe() {
  const script = [
    '$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,CreationDate',
    '$net = netstat -ano | Select-String LISTENING',
    '[pscustomobject]@{ procs = $procs; net = @($net | ForEach-Object { $_.ToString() }) } | ConvertTo-Json -Compress -Depth 4',
  ].join('; ');

  const out = await ps(script, 60000);
  const procs = [];
  const ports = new Map();

  if (!out) return { procs, ports };

  let parsed;
  try { parsed = JSON.parse(out); } catch { return { procs, ports }; }

  const rawProcs = parsed.procs ? (Array.isArray(parsed.procs) ? parsed.procs : [parsed.procs]) : [];
  for (const p of rawProcs) {
    const pid = Number(p.ProcessId);
    if (!Number.isFinite(pid)) continue;
    procs.push({
      pid,
      name: String(p.Name || ''),
      cmd: String(p.CommandLine || ''),
      startedAt: p.CreationDate || null,
    });
  }

  const rawNet = parsed.net ? (Array.isArray(parsed.net) ? parsed.net : [parsed.net]) : [];
  for (const line of rawNet) {
    const cols = String(line).trim().split(/\s+/);
    if (cols.length < 5) continue;
    const local = cols[1] || '';
    const pid = Number(cols[cols.length - 1]);
    if (!Number.isFinite(pid)) continue;
    const m = /:(\d+)$/.exec(local);
    if (!m) continue;
    const port = Number(m[1]);
    if (!ports.has(port)) ports.set(port, []);
    const list = ports.get(port);
    if (!list.includes(pid)) list.push(pid);
  }

  return { procs, ports };
}

/**
 * Background status cache.
 *
 * A full probe costs seconds on this machine, which is far too slow to run inside
 * an HTTP request or a 1-second UI tick. The probe therefore runs on its own
 * schedule in the background and the most recent result is served immediately;
 * callers see a sub-millisecond response with data at most one interval old.
 */
class StatusCache {
  constructor(opts = {}) {
    this.intervalMs = opts.intervalMs || 5000;
    this.data = null;
    this.at = 0;
    this.lastError = null;
    this.timer = null;
    this.refreshing = false;
  }

  /** Run one probe and rebuild the service status list. */
  async refresh() {
    if (this.refreshing) return this.data;
    this.refreshing = true;
    try {
      const { procs, ports } = await probe();
      if (!procs.length) {
        this.lastError = lastProbeError || '无法读取进程列表';
      } else {
        this.lastError = null;
      }
      const out = [];
      for (const k of ORDER) out.push(await status(k, procs, ports));
      this.data = out;
      this.at = Date.now();
    } catch (e) {
      this.lastError = e.message || String(e);
    } finally {
      this.refreshing = false;
    }
    return this.data;
  }

  start() {
    if (this.timer) return;
    // Prime immediately, then keep refreshing in the background.
    this.refresh().catch(() => {});
    this.timer = setInterval(() => { this.refresh().catch(() => {}); }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Latest known status, or null before the first probe completes. */
  get() {
    return this.data;
  }

  /** Force an immediate refresh (used after start/stop actions). */
  async forceRefresh() {
    return this.refresh();
  }

  age() {
    return this.at ? Date.now() - this.at : null;
  }
}

const statusCache = new StatusCache();

/** Status of every service. */
async function statusAll() {
  const cached = statusCache.get();
  if (cached) return cached;
  return statusCache.refresh();
}

/** Status from the background cache, refreshing only if nothing is available yet. */
async function statusAllCached() {
  return statusAll();
}

/** Invalidate the cache (called after any start/stop so the UI updates at once). */
function invalidateStatusCache() {
  statusCache.forceRefresh().catch(() => {});
}

/** Start one service, waiting for its ports to come up. */
async function start(key, { waitMs = 40000 } = {}) {
  const svc = SERVICES[key];
  if (!svc) throw new Error(`unknown service: ${key}`);
  invalidateStatusCache();

  const before = await status(key);
  if (before.running) return { key, started: false, reason: '已在运行', pid: before.pid };

  let pid;
  try {
    pid = await svc.start();
  } catch (e) {
    return { key, started: false, reason: `启动失败: ${e.message}`, pid: null };
  }

  // Wait for readiness. FRPC has no local port to poll, so it is given a fixed
  // grace period instead.
  if (svc.ports.length === 0) {
    await sleep(3000);
    const after = await status(key);
    return {
      key,
      started: after.running,
      reason: after.running ? '已启动' : '已启动但未检测到进程',
      pid: after.pid || pid,
    };
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const after = await status(key);
    if (after.running) return { key, started: true, reason: '已启动', pid: after.pid };
  }
  const after = await status(key);
  return {
    key,
    started: false,
    reason: after.pid ? '进程已启动但端口未就绪' : '启动超时',
    pid: after.pid || pid,
  };
}

/**
 * Stop one service, terminating its whole process tree.
 *
 * @param {string} key
 * @param {{dryRun?: boolean}} [opts] When dryRun is set, the set of processes
 *   that *would* be killed is computed and returned, but nothing is terminated.
 *   This exists so the stop logic can be verified without risking the loss of a
 *   service that cannot be restarted remotely.
 */
async function stop(key, opts = {}) {
  const dryRun = !!opts.dryRun;
  const svc = SERVICES[key];
  if (!svc) throw new Error(`unknown service: ${key}`);
  invalidateStatusCache();

  const st = await status(key);
  const pids = new Set();

  if (st.pid) pids.add(st.pid);
  // Include any process whose command line matches, so orphans are cleaned up
  // too. The pattern is service-specific, so this cannot hit unrelated programs.
  const list = await listProcesses();
  for (const p of list) if (serviceMatches(svc, p)) pids.add(p.pid);
  // Port holders are a final safety net for the port-based services.
  for (const p of svc.ports) {
    for (const h of await portHolders(p)) pids.add(h);
  }

  // Policy guard: some services must never be stopped by this tooling at all,
  // no matter how it was launched. DSH is one of them by default: this machine is
  // frequently operated remotely, and killing DSH would end the session with no
  // way to restart it without physical access to the keyboard.
  if (isNeverStop(key)) {
    return {
      key,
      stopped: false,
      reason: `已拒绝停止 ${svc.name}：该服务受保护（data/config.json 的 safety.neverStop）。请手动关闭。`,
      killed: [],
      blocked: [],
      policyBlocked: true,
    };
  }

  // Remove this process and every ancestor. Without this, "stop all" run from
  // inside a DSH session would kill the DSH host that is running the command.
  const blocked = [];
  for (const pid of [...pids]) {
    if (isProtected(pid)) {
      pids.delete(pid);
      blocked.push(pid);
    }
  }

  if (pids.size === 0) {
    return {
      key,
      stopped: false,
      reason: blocked.length
        ? `未停止：目标进程是本会话自身或祖先 (PID ${blocked.join(', ')})，已跳过以避免中断当前会话`
        : '未在运行',
      killed: [],
      blocked,
    };
  }

  if (dryRun) {
    return {
      key,
      stopped: false,
      dryRun: true,
      reason: `演练：将会停止 PID ${[...pids].join(', ')}`,
      wouldKill: [...pids],
      killed: [],
      blocked,
    };
  }

  const killed = [];
  for (const pid of pids) {
    await killTree(pid);
    killed.push(pid);
  }
  clearPid(key);
  await sleep(1200);

  const after = await status(key);
  return {
    key,
    stopped: !after.running,
    reason: blocked.length
      ? `部分停止（保留了 ${blocked.join(', ')}）`
      : after.running ? '仍有进程存活' : '已停止',
    killed,
    blocked,
  };
}

/** Start every service in dependency order. */
async function startAll() {
  const results = [];
  for (const k of ORDER) results.push(await start(k));
  return results;
}

/**
 * Stop every service in reverse dependency order (tunnel first).
 *
 * Services listed in NEVER_STOP are reported as skipped rather than stopped. The
 * guard also lives inside stop(), so this is a convenience for callers that want
 * a complete result set, not the only line of defence.
 *
 * @param {{dryRun?: boolean}} [opts]
 */
async function stopAll(opts = {}) {
  const results = [];
  for (const k of [...ORDER].reverse()) {
    if (isNeverStop(k)) {
      results.push({
        key: k,
        stopped: false,
        reason: `已跳过 ${SERVICES[k].name}：该服务受保护（safety.neverStop），只允许手动关闭`,
        killed: [],
        blocked: [],
        policyBlocked: true,
      });
      continue;
    }
    results.push(await stop(k, opts));
  }
  return results;
}

module.exports = {
  SERVICES, ORDER, ROOT, DATA_DIR, FRPC_DIR,
  listProcesses, listeningPorts, portHolders, portOpen, killTree,
  serviceMatches, pidAlive,
  isProtected, PROTECTED_PIDS, isNeverStop, NEVER_STOP,
  probeError, probe,
  status, statusAll, statusAllCached, invalidateStatusCache,
  statusCache, StatusCache,
  start, stop, startAll, stopAll,
};
