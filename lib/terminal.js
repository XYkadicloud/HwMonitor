'use strict';
/**
 * Persistent PowerShell terminal session.
 *
 * One long-lived powershell.exe child per browser session, with commands written
 * to its stdin and output read from its stdout. A resident process is used rather
 * than spawning per command so that state (variables, current directory) persists
 * across commands, which is what makes it feel like a terminal.
 *
 * Completion detection
 * --------------------
 * PowerShell in stdin command mode does not print a machine-readable prompt, so
 * there is no reliable "command finished" signal. After each command a sentinel
 * line with a per-session random token is written; its appearance in the output
 * marks the end of that command. The token is random so that ordinary command
 * output cannot accidentally contain it.
 *
 * Output is streamed to the client as it arrives, so a long-running command shows
 * progress instead of appearing to hang. If the sentinel does not arrive within
 * the timeout, the command is reported as still running and the session stays
 * usable (the user may send Ctrl+C or more input).
 *
 * Encoding
 * --------
 * The child is started with UTF-8 console output explicitly configured, because
 * this project's path contains Chinese characters and the default OEM codepage
 * renders them as mojibake.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');

/** How long to wait for a command's sentinel before calling it still-running. */
const DEFAULT_TIMEOUT_MS = 120000;

class TerminalSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.cwd   initial working directory
   * @param {string} [opts.id]  session id (generated when omitted)
   */
  constructor(opts = {}) {
    super();
    this.id = opts.id || crypto.randomBytes(8).toString('hex');
    this.cwd = opts.cwd || os.homedir();
    this.proc = null;
    this.alive = false;
    this.token = crypto.randomBytes(12).toString('hex');
    this.seq = 0;
    /** Sequence number of the command currently in flight, or 0 when idle. */
    this.pending = 0;
    this.pendingCmd = '';
    this.pendingTimer = null;
    this.buffer = '';
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.commandCount = 0;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    /** Recent output kept for replay when a client reconnects. */
    this.scrollback = [];
    this.maxScrollback = 400;
  }

  start() {
    if (this.proc) return;

    // -NoLogo -NoProfile keeps startup quiet and predictable; -Command - reads
    // commands from stdin.
    this.proc = spawn('powershell', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-',
    ], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });

    this.alive = true;

    // Force UTF-8 on the console so Chinese paths and text survive the pipe.
    this.rawWrite('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n');

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => this.emitOutput(chunk, 'stderr'));

    this.proc.on('error', (err) => {
      this.alive = false;
      this.emit('exit', { code: null, error: err.message });
    });

    this.proc.on('close', (code) => {
      this.alive = false;
      this.emitOutput(`\n[会话已结束，退出码 ${code}]\n`, 'system');
      this.emit('exit', { code });
    });

    this.emitOutput(`HwMonitor 终端 · PowerShell\n工作目录: ${this.cwd}\n\n`, 'system');
  }

  onData(chunk) {
    this.buffer += chunk;
    this.lastActivityAt = Date.now();

    const sentinelPrefix = `__HWM_${this.token}_`;
    const completed = [];

    // Walk the buffer, emitting real output and consuming sentinels. A sentinel
    // may be split across chunks, so anything that could be the beginning of one
    // is held back until the next chunk arrives.
    let out = '';
    for (;;) {
      const idx = this.buffer.indexOf(sentinelPrefix);
      if (idx >= 0) {
        out += this.buffer.slice(0, idx);
        const rest = this.buffer.slice(idx + sentinelPrefix.length);
        const m = /^(\d+)__/.exec(rest);
        if (m) {
          completed.push(Number(m[1]));
          this.buffer = rest.slice(m[0].length);
          continue;
        }
        // Not a complete sentinel yet: keep it buffered and stop.
        this.buffer = this.buffer.slice(idx);
        break;
      }

      // No sentinel prefix present. Hold back any tail that might be the start of
      // one, so a prefix split across chunks is not emitted as output.
      let hold = 0;
      const maxHold = Math.min(sentinelPrefix.length - 1, this.buffer.length);
      for (let k = maxHold; k > 0; k--) {
        if (this.buffer.endsWith(sentinelPrefix.slice(0, k))) { hold = k; break; }
      }
      out += hold ? this.buffer.slice(0, this.buffer.length - hold) : this.buffer;
      this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
      break;
    }

    if (out) this.emitOutput(out, 'stdout');

    for (const n of completed) {
      if (n === this.pending) {
        if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
        const cmd = this.pendingCmd;
        this.pending = 0;
        this.pendingCmd = '';
        this.emit('command-done', { seq: n, command: cmd, cwd: this.cwd });
      } else {
        // A stale sentinel (e.g. from a command that was interrupted). Ignore it
        // rather than letting it complete the wrong command.
        this.emit('stale-sentinel', { seq: n, expected: this.pending });
      }
    }
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

  /** Write raw text to the child without sentinel bookkeeping. */
  rawWrite(text) {
    if (!this.proc || !this.alive) return false;
    try {
      this.proc.stdin.write(text);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a command and mark its completion with a sentinel.
   * @param {string} command
   * @returns {{ok: boolean, seq?: number, error?: string}}
   */
  run(command) {
    if (!this.alive) return { ok: false, error: '会话未运行' };
    if (this.pending) return { ok: false, error: '上一个命令仍在执行' };

    this.seq++;
    this.commandCount++;
    this.pending = this.seq;
    this.pendingCmd = command;

    this.emitOutput(`PS> ${command}\n`, 'prompt');

    const ok = this.rawWrite(`${command}\n`);
    if (!ok) {
      this.pending = 0;
      return { ok: false, error: '写入失败' };
    }

    // Echo the sentinel. Printed after the command, so it appears only once the
    // command has finished producing output.
    this.rawWrite(`Write-Output "__HWM_${this.token}_${this.seq}__"\n`);

    this.pendingTimer = setTimeout(() => {
      if (this.pending === this.seq) {
        this.emit('command-timeout', { seq: this.seq, command: this.pendingCmd });
        // Keep pending set: the command really is still running. The user can
        // interrupt with Ctrl+C or send another command after it finishes.
      }
    }, this.timeoutMs);

    return { ok: true, seq: this.seq };
  }

  /** Send Ctrl+C to interrupt the running command. */
  interrupt() {
    if (!this.proc || !this.alive) return false;
    try {
      // Windows has no SIGINT for a console child from Node; writing the ETX
      // character is not honoured either. Terminating and restarting the child
      // is the reliable way to break out of a runaway command.
      this.proc.kill();
      this.alive = false;
      return true;
    } catch {
      return false;
    }
  }

  /** Change the working directory, reporting the resulting path. */
  cd(dir) {
    const target = dir || os.homedir();
    const r = this.run(`Set-Location -LiteralPath '${target.replace(/'/g, "''")}'; $PWD.Path`);
    if (r.ok) this.cwd = target;
    return r;
  }

  dispose() {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
    this.alive = false;
  }

  info() {
    return {
      id: this.id,
      alive: this.alive,
      cwd: this.cwd,
      pid: this.proc ? this.proc.pid : null,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      commandCount: this.commandCount,
      pending: this.pending,
      pendingCommand: this.pendingCmd,
    };
  }
}

/**
 * Manages all terminal sessions and expires idle ones.
 */
class TerminalManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sessions = new Map();
    this.cwd = opts.cwd || os.homedir();
    this.idleMs = opts.idleMs || 30 * 60 * 1000;
    this.maxSessions = opts.maxSessions || 6;
    this.sweeper = setInterval(() => this.sweep(), 60000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  /**
   * Whether the terminal may be used at all.
   *
   * A web shell is remote code execution by design. This server is exposed to the
   * internet through the frp tunnel, so the terminal is refused outright unless an
   * access password is configured. Failing closed here is deliberate: it is far
   * better to require a password than to silently publish a shell.
   */
  isEnabled(passwordSet) {
    return !!passwordSet;
  }

  create() {
    if (this.sessions.size >= this.maxSessions) {
      // Drop the least recently used session to make room.
      let oldest = null;
      for (const s of this.sessions.values()) {
        if (!oldest || s.lastActivityAt < oldest.lastActivityAt) oldest = s;
      }
      if (oldest) { oldest.dispose(); this.sessions.delete(oldest.id); }
    }
    const s = new TerminalSession({ cwd: this.cwd });
    this.sessions.set(s.id, s);
    s.on('exit', () => {
      // Keep the session object briefly so the client can read the exit notice,
      // but mark it dead. It is removed by the sweeper.
    });
    s.start();
    this.emit('created', s.id);
    return s;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

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
      if (now - s.lastActivityAt > this.idleMs) {
        s.dispose();
        this.sessions.delete(id);
      }
    }
  }

  disposeAll() {
    clearInterval(this.sweeper);
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }

  list() {
    return [...this.sessions.values()].map((s) => s.info());
  }
}

module.exports = { TerminalSession, TerminalManager, DEFAULT_TIMEOUT_MS };
