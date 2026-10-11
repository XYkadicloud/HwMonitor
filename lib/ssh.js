'use strict';
/**
 * SSH session manager for the web terminal.
 *
 * Design constraints, all established by probing this machine's OpenSSH (8.1p1)
 * rather than assumed:
 *
 *   * `ssh.exe` does NOT read a password from stdin. Feeding one on stdin makes it
 *     block forever waiting on the console. Password authentication therefore
 *     needs an askpass helper: SSH_ASKPASS is honoured when ssh has no terminal to
 *     prompt on, which is the case for a spawned child.
 *   * Key-based authentication works unattended and is the preferred path.
 *   * `-tt` (pseudo-terminal) is NOT usable here, despite being the obvious way to
 *     get a stateful shell. With a piped stdin, Windows OpenSSH 8.1 splits the
 *     echo of typed input from the command output, and the output arrives as all
 *     commands concatenated on one line with the results missing entirely
 *     (verified by dumping the raw stream). The result is unusable, so no tty is
 *     requested.
 *   * Without a tty, each command runs in its own shell, so shell state does not
 *     persist between commands. The UI states this plainly rather than pretending
 *     otherwise; users needing persistent state can start an interactive program
 *     (for example `bash` or `python`) as a single long-running command.
 *   * `BatchMode=yes` makes authentication failures fail fast instead of hanging,
 *     which matters because a hung child would hold a web session open forever.
 *
 * The password is never placed on a command line (visible to other processes via
 * WMI); it goes into a temporary file read by the askpass helper, and both are
 * removed when the session ends.
 *
 * Completion detection mirrors the PowerShell terminal: a sentinel is echoed after
 * each command so the end of output can be recognised without a prompt.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const SSH_EXE = process.env.WINDIR
  ? path.join(process.env.WINDIR, 'System32', 'OpenSSH', 'ssh.exe')
  : 'ssh.exe';

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Strip ANSI/VT control sequences from a chunk of terminal output.
 *
 * Even without requesting a tty, ssh may emit a window-title sequence or a
 * "pseudo-terminal will not be allocated" notice. The web terminal shows plain
 * text, so control sequences are removed rather than rendered.
 */
function stripAnsi(text) {
  return String(text)
    // OSC ... BEL or OSC ... ST (window title etc.)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // CSI sequences: ESC [ params final-byte
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // Other two-character escapes
    .replace(/\u001b[@-Z\\-_]/g, '')
    // Lone ESC
    .replace(/\u001b/g, '')
    // Backspace characters
    .replace(/[\b]/g, '');
}

/**
 * Decode a chunk of remote output.
 *
 * ssh passes through whatever encoding the remote program emits. A Windows remote
 * host emits its console codepage (GBK on a Chinese system), which is not valid
 * UTF-8: decoding it as UTF-8 produces replacement characters (observed in the
 * Windows banner: "Microsoft Windows [\uFFFD\u5206 ...]"). Chunks that are valid
 * UTF-8 are kept as-is; otherwise the bytes are decoded using the OEM codepage so
 * Chinese text from a Windows remote host renders correctly.
 */
function decodeChunk(buf, oemDecoder) {
  const s = buf.toString('utf8');
  if (!s.includes('\uFFFD')) return s;
  // Invalid UTF-8: re-decode the raw bytes with the remote's likely codepage.
  try {
    return oemDecoder.decode(buf);
  } catch {
    return s;
  }
}

/** Lazily-created GBK/OEM decoder for non-UTF-8 remote output. */
let oemDecoderCache = null;
function oemDecoder() {
  if (oemDecoderCache) return oemDecoderCache;
  try {
    // Node's built-in support for GBK is provided by the full-icu data that ships
    // with modern Node builds.
    oemDecoderCache = new TextDecoder('gbk');
  } catch {
    try { oemDecoderCache = new TextDecoder('gb18030'); }
    catch { oemDecoderCache = new TextDecoder('latin1'); }
  }
  return oemDecoderCache;
}

/** Known-hosts file used for connections (the user's own). */
function knownHostsPath() {
  return path.join(os.homedir(), '.ssh', 'known_hosts');
}

class SshSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port]
   * @param {string} opts.user
   * @param {string} [opts.password]   used only when no key works
   * @param {string} [opts.keyPath]    private key to use
   * @param {boolean} [opts.acceptNewHostKey]
   */
  constructor(opts = {}) {
    super();
    this.id = opts.id || crypto.randomBytes(8).toString('hex');
    this.host = String(opts.host || '');
    this.port = Number(opts.port) || 22;
    this.user = String(opts.user || '');
    this.password = opts.password ? String(opts.password) : '';
    this.keyPath = opts.keyPath ? String(opts.keyPath) : '';
    this.acceptNewHostKey = opts.acceptNewHostKey !== false;

    this.proc = null;
    this.alive = false;
    this.connected = false;
    this.token = crypto.randomBytes(12).toString('hex');
    this.seq = 0;
    this.pending = 0;
    this.pendingCmd = '';
    this.pendingTimer = null;
    this.buffer = '';
    this.scrollback = [];
    this.maxScrollback = 500;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.commandCount = 0;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.askpassFile = null;
    this.lastError = null;
  }

  /** Common ssh options. BatchMode keeps failures fast and never prompts. */
  baseArgs() {
    const args = [
      // No -tt: with a piped stdin, Windows OpenSSH 8.1 mangles the output of a
      // forced pseudo-terminal (commands concatenated, results missing). Each
      // command therefore runs in its own shell; the UI says so explicitly.
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', `UserKnownHostsFile=${knownHostsPath()}`,
    ];
    if (this.acceptNewHostKey) {
      // Accepting a new key on first connect is required for unattended use;
      // changed keys are still rejected by ssh itself.
      args.push('-o', 'StrictHostKeyChecking=accept-new');
    }
    if (this.keyPath) args.push('-i', this.keyPath);
    args.push('-p', String(this.port));
    args.push(`${this.user}@${this.host}`);
    return args;
  }

  /**
   * Create the askpass helper used for password authentication.
   *
   * ssh runs this program when it needs a password and has no terminal. The file
   * is written to the user's temp directory and removed on dispose; the password
   * is stored in a companion file rather than inline so it does not appear in the
   * script text or in any process listing.
   */
  ensureAskpass() {
    if (this.askpassFile) return this.askpassFile;
    if (!this.password) return null;
    try {
      const dir = path.join(os.tmpdir(), `hwm-ssh-${this.id}`);
      fs.mkdirSync(dir, { recursive: true });
      const secret = path.join(dir, 'secret.txt');
      fs.writeFileSync(secret, this.password, 'utf8');
      const cmd = path.join(dir, 'askpass.cmd');
      // `type` prints the file verbatim, which is exactly what askpass must do.
      fs.writeFileSync(cmd, `@echo off\r\ntype "${secret}"\r\n`, 'ascii');
      this.askpassFile = cmd;
      this.askpassSecret = secret;
      return cmd;
    } catch {
      return null;
    }
  }

  /** Start the persistent shell on the remote host. */
  start() {
    if (this.proc) return;

    const askpass = this.ensureAskpass();
    const args = this.baseArgs();

    this.proc = spawn(SSH_EXE, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(askpass ? { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'hwm:0' } : {}),
      },
    });

    this.alive = true;
    this.emitOutput(`正在连接 ${this.user}@${this.host}:${this.port} …\n`, 'system');

    // Collect raw bytes rather than setting a string encoding: remote output may
    // be GBK (Windows console) rather than UTF-8, and the correct decoder cannot
    // be chosen until the bytes are seen.
    this.proc.stdout.on('data', (buf) => this.onData(decodeChunk(buf, oemDecoder())));

    this.proc.stderr.on('data', (buf) => {
      const text = decodeChunk(buf, oemDecoder());
      this.emitOutput(text, 'stderr');
      // ssh reports a successful login by printing the banner (if any) and then
      // going quiet. Absence of an auth error plus a live process is the signal
      // used here; the first successful command confirms it definitively.
      if (/Permission denied|Connection refused|Could not resolve|Connection timed out|Host key verification failed/i.test(text)) {
        this.lastError = text.trim();
      }
    });
    this.proc.on('error', (err) => {
      this.alive = false;
      this.lastError = err.message;
      this.emitOutput(`无法启动 ssh: ${err.message}\n`, 'stderr');
      this.emit('exit', { code: null, error: err.message });
    });

    this.proc.on('close', (code) => {
      this.alive = false;
      this.connected = false;
      this.emitOutput(`\n[SSH 会话已结束，退出码 ${code}]\n`, 'system');
      this.emit('exit', { code, error: this.lastError });
    });

    // Mark connected once the remote shell has had time to establish; the first
    // command's success is the real confirmation.
    setTimeout(() => {
      if (this.alive) {
        this.connected = true;
        this.emit('connected', { host: this.host, user: this.user, port: this.port });
      }
    }, 2500);
  }

  onData(chunk) {
    // Strip ANSI control sequences before anything else. A -tt session emits
    // cursor addressing and erase codes, and the sentinel itself can be wrapped in
    // them, so stripping first keeps the sentinel detection reliable.
    this.buffer += stripAnsi(chunk);
    this.lastActivityAt = Date.now();

    const prefix = `__HWM_SSH_${this.token}_`;
    const completed = [];
    let out = '';

    for (;;) {
      const idx = this.buffer.indexOf(prefix);
      if (idx >= 0) {
        out += this.buffer.slice(0, idx);
        const rest = this.buffer.slice(idx + prefix.length);
        const m = /^(\d+)__/.exec(rest);
        if (m) {
          completed.push(Number(m[1]));
          this.buffer = rest.slice(m[0].length);
          continue;
        }
        this.buffer = this.buffer.slice(idx);
        break;
      }
      // Hold back a possible partial sentinel at the tail.
      let hold = 0;
      const maxHold = Math.min(prefix.length - 1, this.buffer.length);
      for (let k = maxHold; k > 0; k--) {
        if (this.buffer.endsWith(prefix.slice(0, k))) { hold = k; break; }
      }
      out += hold ? this.buffer.slice(0, this.buffer.length - hold) : this.buffer;
      this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
      break;
    }

    // A -tt session echoes the commands that were typed. Showing the echo as well
    // as our own prompt line would duplicate every command, so the echo of the
    // sentinel and of the just-issued command is dropped.
    if (out) {
      out = this.dedupeEcho(out);
      if (out.trim()) this.emitOutput(out, 'stdout');
    }

    for (const n of completed) {
      if (n === this.pending) {
        if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
        const cmd = this.pendingCmd;
        this.pending = 0;
        this.pendingCmd = '';
        this.connected = true;
        this.emit('command-done', { seq: n, command: cmd });
      }
    }
  }

  /**
   * Remove the terminal's echo of the command we just sent.
   *
   * With -tt the remote shell echoes input back, so the transcript would show each
   * command twice: once from our own prompt line and once from the echo. The echo
   * line is dropped to keep the display clean.
   */
  dedupeEcho(text) {
    if (!this.pendingCmd) return text;
    const cmd = this.pendingCmd;
    const lines = text.split('\n');
    const kept = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Drop a line that is just our command echoed back, optionally preceded by
      // the shell prompt.
      if (trimmed === cmd) continue;
      if (trimmed.endsWith(cmd) && trimmed.length < cmd.length + 80) {
        const prefix = trimmed.slice(0, trimmed.length - cmd.length);
        // Keep the prompt itself if present, drop the echoed command.
        if (prefix.trim()) kept.push(prefix.replace(/\s+$/, ''));
        continue;
      }
      kept.push(line);
    }
    return kept.join('\n');
  }

  emitOutput(text, stream) {
    if (!text) return;
    const entry = { at: Date.now(), stream, text };
    this.scrollback.push(entry);
    if (this.scrollback.length > this.maxScrollback) {
      this.scrollback.splice(0, this.scrollback.length - this.maxScrollback);
    }
    this.emit('output', entry);
  }

  rawWrite(text) {
    if (!this.proc || !this.alive) return false;
    try { this.proc.stdin.write(text); return true; } catch { return false; }
  }

  /** Run a command on the remote host, marking completion with a sentinel. */
  run(command) {
    if (!this.alive) return { ok: false, error: '会话未运行' };
    if (this.pending) return { ok: false, error: '上一个命令仍在执行' };

    this.seq++;
    this.commandCount++;
    this.pending = this.seq;
    this.pendingCmd = command;
    this.emitOutput(`${this.user}@${this.host}$ ${command}\n`, 'prompt');

    if (!this.rawWrite(`${command}\n`)) {
      this.pending = 0;
      return { ok: false, error: '写入失败' };
    }
    // The sentinel is printed by the remote shell after the command completes.
    this.rawWrite(`echo __HWM_SSH_${this.token}_${this.seq}__\n`);

    this.pendingTimer = setTimeout(() => {
      if (this.pending === this.seq) {
        this.emit('command-timeout', { seq: this.seq, command: this.pendingCmd });
      }
    }, this.timeoutMs);

    return { ok: true, seq: this.seq };
  }

  dispose() {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
    this.alive = false;
    // Remove the askpass helper and the stored password.
    try {
      if (this.askpassSecret) fs.unlinkSync(this.askpassSecret);
      if (this.askpassFile) fs.unlinkSync(this.askpassFile);
      const dir = path.join(os.tmpdir(), `hwm-ssh-${this.id}`);
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    } catch {}
    this.password = '';
  }

  info() {
    return {
      id: this.id,
      kind: 'ssh',
      alive: this.alive,
      connected: this.connected,
      host: this.host,
      port: this.port,
      user: this.user,
      pid: this.proc ? this.proc.pid : null,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      commandCount: this.commandCount,
      pending: this.pending,
      pendingCommand: this.pendingCmd,
      lastError: this.lastError,
      authMode: this.keyPath ? 'key' : (this.password ? 'password' : 'agent'),
      // Each command runs in a fresh shell (no pseudo-terminal is available; see
      // the note at the top of this file). Surfaced so the UI can tell the user
      // instead of silently losing state between commands.
      stateful: false,
    };
  }
}

/**
 * Manages SSH sessions alongside the PowerShell ones.
 */
class SshManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sessions = new Map();
    this.idleMs = opts.idleMs || 30 * 60 * 1000;
    this.maxSessions = opts.maxSessions || 6;
    this.sweeper = setInterval(() => this.sweep(), 60000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  create(conn) {
    if (this.sessions.size >= this.maxSessions) {
      let oldest = null;
      for (const s of this.sessions.values()) {
        if (!oldest || s.lastActivityAt < oldest.lastActivityAt) oldest = s;
      }
      if (oldest) { oldest.dispose(); this.sessions.delete(oldest.id); }
    }
    const s = new SshSession(conn);
    this.sessions.set(s.id, s);
    s.start();
    this.emit('created', s.id);
    return s;
  }

  get(id) { return this.sessions.get(id) || null; }

  destroy(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.dispose();
    this.sessions.delete(id);
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivityAt > this.idleMs) { s.dispose(); this.sessions.delete(id); }
    }
  }

  disposeAll() {
    clearInterval(this.sweeper);
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }

  list() { return [...this.sessions.values()].map((s) => s.info()); }
}

module.exports = { SshSession, SshManager, SSH_EXE, stripAnsi };
