'use strict';
/**
 * DSH usage analyzer.
 *
 * Reads DeepSeek Harness session logs and derives token usage, cost, tool-call
 * statistics, and live activity. Everything here is read-only: DSH itself is
 * never modified, so this cannot destabilise a running session.
 *
 * Log format (discovered by inspection of ~/.dsh/sessions):
 *   <sessions>/<workspace-slug>/<session-id>/session.v4.jsonl.zstd
 * Each file is a concatenation of independent zstd frames, each holding one or
 * more JSONL events. Files grow as the session runs, so the analyzer decodes
 * only newly appended bytes after the first pass.
 *
 * Relevant event types:
 *   session            {id, version, createdAt, cwd, agentPreset}
 *   session/title      {title, source}
 *   assistant/message  {message:{source:{provider,model}}, usage:{...}}
 *   tool/call          {callId, name, arguments}
 *   tool/result        {message:{toolCallId, content}}
 *   turn/start|end     {turn}, end carries {reason:{kind}}
 *   step/start|end     {turn, step}
 *   model/selection    {provider, model, reasoningEffort}
 *   goal/change        {operation, goal:{id, objective, ...}}
 *   todo/write         {todos:[{content, status}]}
 *   compaction/start|end, subagent/catalog, deliverables/presented
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { decompressFrames, parseJsonl } = require('./zstd-jsonl');

const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const LOG_NAME = 'session.v4.jsonl.zstd';

/** Decode a workspace slug like `--E-android~0020app--` into a path. */
function decodeWorkspaceSlug(slug) {
  let s = slug;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  // `~0020` style escapes encode characters that are illegal in paths.
  s = s.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  // Slug uses '-' for the separator; restore a drive-style path when possible.
  const m = /^([A-Za-z])-(.*)$/.exec(s);
  if (m) return `${m[1]}:\\${m[2].replace(/-/g, '\\')}`;
  return s.replace(/-/g, '\\');
}

/** Per-session aggregate state. */
class SessionState {
  constructor(id, filePath) {
    this.id = id;
    this.filePath = filePath;
    this.offset = 0;
    this.decodedChars = 0;
    this.eventCount = 0;
    this.meta = null;
    this.title = null;
    this.cwd = null;
    this.agentPreset = null;
    this.createdAt = null;

    /** @type {Map<string, {provider:string, model:string, calls:number, inputTokens:number, outputTokens:number, reasoningTokens:number, cacheReadTokens:number, totalTokens:number}>} */
    this.models = new Map();
    /** @type {Map<string, number>} */
    this.tools = new Map();
    this.turnCount = 0;
    this.stepCount = 0;
    this.lastTurn = 0;
    this.lastStep = 0;
    this.lastEventAt = null;
    this.firstEventAt = null;
    this.turnEndKinds = {};
    this.compactions = 0;
    this.subagents = 0;
    this.presentations = 0;
    this.goal = null;
    this.todos = null;
    this.modelSelection = null;
    /** Recent activity, newest last, bounded. */
    this.recentTools = [];
    /** Tool calls that produced an error-ish result, bounded. */
    this.recentErrors = [];
    this.lastAssistantText = null;
    this.userMessageCount = 0;
    this.workspaceChanges = 0;
  }

  get totalTokens() {
    let input = 0, output = 0, reasoning = 0, cacheRead = 0, calls = 0;
    for (const m of this.models.values()) {
      input += m.inputTokens;
      output += m.outputTokens;
      reasoning += m.reasoningTokens;
      cacheRead += m.cacheReadTokens;
      calls += m.calls;
    }
    return { input, output, reasoning, cacheRead, calls };
  }

  /** Human-readable duration between first and last event. */
  spanMs() {
    if (!this.firstEventAt || !this.lastEventAt) return 0;
    return this.lastEventAt - this.firstEventAt;
  }

  isActive(withinMs = 120000) {
    if (!this.lastEventAt) return false;
    return Date.now() - this.lastEventAt < withinMs;
  }
}

class DshAnalyzer {
  /**
   * @param {object} opts
   * @param {string} [opts.sessionsRoot]
   * @param {number} [opts.maxRecentTools]
   */
  constructor(opts = {}) {
    this.root = opts.sessionsRoot || SESSIONS_ROOT;
    this.maxRecentTools = opts.maxRecentTools || 40;
    /** @type {Map<string, SessionState>} keyed by file path */
    this.sessions = new Map();
    this.lastScanAt = null;
    this.lastScanMs = null;
    this.lastScanErrors = [];
    this.totalBytesRead = 0;
    this.initialScanDone = false;
    /**
     * Bumped whenever any session's state actually changes. Callers poll this
     * to avoid re-broadcasting a large report when nothing new happened.
     */
    this.revision = 0;
  }

  /** Locate all session log files. */
  discover() {
    const out = [];
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 4) walk(p, depth + 1);
        } else if (e.name === LOG_NAME) {
          out.push(p);
        }
      }
    };
    walk(this.root, 0);
    return out;
  }

  /**
   * Read and decode newly appended bytes for one session file.
   * Only the tail beyond the last consumed frame is read, so polling a 5MB log
   * that has not changed costs a single stat() call.
   */
  updateSession(filePath) {
    let st = this.sessions.get(filePath);
    if (!st) {
      const id = path.basename(path.dirname(filePath));
      st = new SessionState(id, filePath);
      this.sessions.set(filePath, st);
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return st; // file removed; keep last known state
    }

    if (stat.size < st.offset) {
      // File was truncated or replaced: start over.
      st.offset = 0;
      st.decodedChars = 0;
      st.eventCount = 0;
      this.sessions.set(filePath, Object.assign(new SessionState(st.id, filePath)));
      st = this.sessions.get(filePath);
    }

    if (stat.size <= st.offset) return st;

    let buf;
    try {
      // Read only the appended region.
      const len = stat.size - st.offset;
      buf = Buffer.allocUnsafe(len);
      const fd = fs.openSync(filePath, 'r');
      try {
        fs.readSync(fd, buf, 0, len, st.offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      this.lastScanErrors.push(`${path.basename(filePath)}: ${e.message}`);
      return st;
    }

    this.totalBytesRead += buf.length;
    const { text, consumed } = decompressFrames(buf);
    st.offset += consumed;
    if (!text) return st;

    st.decodedChars += text.length;
    const events = parseJsonl(text);
    if (events.length) this.revision++;
    for (const ev of events) this.applyEvent(st, ev);
    return st;
  }

  /** Fold one session event into aggregate state. */
  applyEvent(st, ev) {
    st.eventCount++;
    const t = typeof ev.time === 'number' ? ev.time : null;
    if (t) {
      if (st.firstEventAt === null || t < st.firstEventAt) st.firstEventAt = t;
      if (st.lastEventAt === null || t > st.lastEventAt) st.lastEventAt = t;
    }

    const d = ev.data || {};

    switch (ev.type) {
      case 'session': {
        st.meta = d;
        st.cwd = d.cwd || st.cwd;
        st.createdAt = d.createdAt || st.createdAt;
        st.agentPreset = d.agentPreset || st.agentPreset;
        break;
      }
      case 'session/title': {
        st.title = d.title || st.title;
        break;
      }
      case 'assistant/message': {
        const msg = d.message || {};
        const src = msg.source || {};
        const usage = d.usage || {};
        const provider = src.provider || 'unknown';
        const model = src.model || 'unknown';
        const key = `${provider}/${model}`;
        let m = st.models.get(key);
        if (!m) {
          m = {
            provider, model, calls: 0,
            inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
            cacheReadTokens: 0, totalTokens: 0,
          };
          st.models.set(key, m);
        }
        m.calls++;
        m.inputTokens += numOr0(usage.inputTokens);
        m.outputTokens += numOr0(usage.outputTokens);
        m.reasoningTokens += numOr0(usage.reasoningTokens);
        m.cacheReadTokens += numOr0(usage.cacheReadTokens);
        m.totalTokens += numOr0(usage.totalTokens);

        // Keep the last assistant text so the UI can show current activity.
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && part.type === 'text' && part.text) st.lastAssistantText = part.text;
          }
        }
        break;
      }
      case 'tool/call': {
        const name = d.name || 'unknown';
        st.tools.set(name, (st.tools.get(name) || 0) + 1);
        st.recentTools.push({
          at: t,
          turn: d.turn,
          step: d.step,
          name,
          callId: d.callId,
          // Arguments can be large; keep a short preview for display.
          argPreview: previewArgs(d.arguments),
        });
        if (st.recentTools.length > this.maxRecentTools) {
          st.recentTools.splice(0, st.recentTools.length - this.maxRecentTools);
        }
        break;
      }
      case 'tool/result': {
        const msg = d.message || {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        const text = content.map((c) => (c && c.text) || '').join('\n');
        // Tool failures are reported as text; flag the obvious ones.
        if (looksLikeError(text)) {
          st.recentErrors.push({
            at: t,
            turn: d.turn,
            step: d.step,
            callId: msg.toolCallId,
            preview: text.slice(0, 300),
          });
          if (st.recentErrors.length > 20) st.recentErrors.shift();
        }
        break;
      }
      case 'turn/start': {
        st.turnCount++;
        if (typeof d.turn === 'number') st.lastTurn = Math.max(st.lastTurn, d.turn);
        break;
      }
      case 'turn/end': {
        const kind = (d.reason && d.reason.kind) || 'unknown';
        st.turnEndKinds[kind] = (st.turnEndKinds[kind] || 0) + 1;
        break;
      }
      case 'step/start': {
        st.stepCount++;
        if (typeof d.turn === 'number') st.lastTurn = Math.max(st.lastTurn, d.turn);
        if (typeof d.step === 'number') st.lastStep = Math.max(st.lastStep, d.step);
        break;
      }
      case 'model/selection': {
        st.modelSelection = { provider: d.provider, model: d.model, reasoningEffort: d.reasoningEffort };
        break;
      }
      case 'goal/change': {
        const op = d.operation;
        if (op === 'create' || op === 'edit' || op === 'resume') {
          st.goal = d.goal ? {
            id: d.goal.id,
            objective: d.goal.objective,
            revision: d.goal.revision,
            status: d.goal.status || 'active',
          } : st.goal;
        } else if (op === 'complete' || op === 'blocked' || op === 'pause') {
          if (st.goal && d.goal && d.goal.id === st.goal.id) {
            st.goal.status = op;
          } else if (d.goal) {
            st.goal = { id: d.goal.id, objective: d.goal.objective, revision: d.goal.revision, status: op };
          }
        }
        break;
      }
      case 'todo/write': {
        if (Array.isArray(d.todos)) {
          st.todos = d.todos.map((x) => ({ content: x.content, status: x.status }));
        }
        break;
      }
      case 'compaction/start': st.compactions++; break;
      case 'subagent/catalog': st.subagents++; break;
      case 'deliverables/presented': st.presentations++; break;
      case 'workspace/changes': st.workspaceChanges++; break;
      case 'user/message': st.userMessageCount++; break;
      default: break;
    }
  }

  /**
   * Scan all sessions, decoding only new data.
   * @param {{full?: boolean}} [opts] `full` forces a re-read of every file.
   */
  scan(opts = {}) {
    const started = Date.now();
    this.lastScanErrors = [];
    if (opts.full) {
      this.sessions.clear();
      this.totalBytesRead = 0;
    }

    const files = this.discover();
    const seen = new Set(files);
    // Drop state for files that no longer exist.
    for (const key of [...this.sessions.keys()]) {
      if (!seen.has(key)) this.sessions.delete(key);
    }

    for (const f of files) this.updateSession(f);

    this.lastScanAt = Date.now();
    this.lastScanMs = this.lastScanAt - started;
    this.initialScanDone = true;
    return this.lastScanMs;
  }

  /** Aggregate cost and totals for one session given a pricing config. */
  summarize(st, cfg, ratesFor) {
    const totals = st.totalTokens;
    let cost = 0;
    let anyPriced = false;
    const models = [];
    for (const m of st.models.values()) {
      const { rates, priced } = ratesFor(cfg, m.provider, m.model);
      const c =
        (m.inputTokens / 1e6) * rates.input +
        (m.outputTokens / 1e6) * rates.output +
        (m.cacheReadTokens / 1e6) * rates.cacheRead;
      if (priced) anyPriced = true;
      cost += c;
      models.push({
        provider: m.provider,
        model: m.model,
        calls: m.calls,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        reasoningTokens: m.reasoningTokens,
        cacheReadTokens: m.cacheReadTokens,
        cost,
        priced,
      });
    }
    // Per-model cost above was overwritten by the running total; recompute.
    for (const mm of models) {
      const { rates } = ratesFor(cfg, mm.provider, mm.model);
      mm.cost =
        (mm.inputTokens / 1e6) * rates.input +
        (mm.outputTokens / 1e6) * rates.output +
        (mm.cacheReadTokens / 1e6) * rates.cacheRead;
    }

    return {
      id: st.id,
      filePath: st.filePath,
      title: st.title,
      cwd: st.cwd || decodeWorkspaceSlug(path.basename(path.dirname(path.dirname(st.filePath)))),
      agentPreset: st.agentPreset,
      createdAt: st.createdAt,
      firstEventAt: st.firstEventAt,
      lastEventAt: st.lastEventAt,
      active: st.isActive(),
      spanMs: st.spanMs(),
      eventCount: st.eventCount,
      turns: st.turnCount,
      steps: st.stepCount,
      lastTurn: st.lastTurn,
      lastStep: st.lastStep,
      userMessages: st.userMessageCount,
      tokens: totals,
      cost,
      priced: anyPriced,
      models,
      tools: [...st.tools.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      turnEndKinds: st.turnEndKinds,
      compactions: st.compactions,
      subagents: st.subagents,
      presentations: st.presentations,
      workspaceChanges: st.workspaceChanges,
      goal: st.goal,
      todos: st.todos,
      modelSelection: st.modelSelection,
      recentTools: st.recentTools.slice(-15),
      recentErrors: st.recentErrors.slice(-5),
      lastAssistantText: st.lastAssistantText ? st.lastAssistantText.slice(0, 400) : null,
    };
  }

  /**
   * Full report across all sessions.
   * @param {object} cfg config object
   * @param {Function} ratesFor pricing resolver
   */
  report(cfg, ratesFor) {
    const sessions = [];
    for (const st of this.sessions.values()) {
      if (!st.meta && st.eventCount === 0) continue;
      sessions.push(this.summarize(st, cfg, ratesFor));
    }
    sessions.sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));

    // Recent-tool detail is only useful for the sessions the user is actually
    // looking at. Keeping it for every session inflated the report to ~73KB,
    // which is wasteful to serialise and push over SSE every few seconds.
    for (let i = 2; i < sessions.length; i++) {
      sessions[i].recentTools = [];
      sessions[i].recentErrors = [];
      sessions[i].lastAssistantText = null;
      sessions[i].todos = null;
    }

    const grand = {
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
      cacheReadTokens: 0, calls: 0, cost: 0, sessions: sessions.length,
      activeSessions: 0,
    };
    const byModel = new Map();
    const byTool = new Map();
    const byDay = new Map();

    for (const s of sessions) {
      grand.inputTokens += s.tokens.input;
      grand.outputTokens += s.tokens.output;
      grand.reasoningTokens += s.tokens.reasoning;
      grand.cacheReadTokens += s.tokens.cacheRead;
      grand.calls += s.tokens.calls;
      grand.cost += s.cost;
      if (s.active) grand.activeSessions++;

      for (const m of s.models) {
        const key = `${m.provider}/${m.model}`;
        let e = byModel.get(key);
        if (!e) {
          e = { provider: m.provider, model: m.model, calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cost: 0, sessions: 0 };
          byModel.set(key, e);
        }
        e.calls += m.calls;
        e.inputTokens += m.inputTokens;
        e.outputTokens += m.outputTokens;
        e.reasoningTokens += m.reasoningTokens;
        e.cacheReadTokens += m.cacheReadTokens;
        e.cost += m.cost;
        e.sessions++;
      }

      for (const tl of s.tools) {
        byTool.set(tl.name, (byTool.get(tl.name) || 0) + tl.count);
      }

      if (s.lastEventAt) {
        const day = new Date(s.lastEventAt).toISOString().slice(0, 10);
        const e = byDay.get(day) || { day, inputTokens: 0, outputTokens: 0, cost: 0, sessions: 0 };
        e.inputTokens += s.tokens.input;
        e.outputTokens += s.tokens.output;
        e.cost += s.cost;
        e.sessions++;
        byDay.set(day, e);
      }
    }

    return {
      available: this.initialScanDone,
      sessionsRoot: this.root,
      scannedAt: this.lastScanAt,
      scanMs: this.lastScanMs,
      errors: this.lastScanErrors.slice(0, 10),
      grand,
      byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls),
      byTool: [...byTool.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      sessions,
    };
  }

  /** The most recently active session, if any. */
  currentSession() {
    let best = null;
    for (const st of this.sessions.values()) {
      if (!best || (st.lastEventAt || 0) > (best.lastEventAt || 0)) best = st;
    }
    return best;
  }
}

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function previewArgs(args) {
  if (args === null || args === undefined) return '';
  let s;
  if (typeof args === 'string') s = args;
  else {
    try { s = JSON.stringify(args); } catch { s = String(args); }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

/**
 * Heuristic detection of a failed tool result.
 * Tool errors surface as ordinary text, so this checks the conventional
 * prefixes DSH uses rather than relying on a structured field.
 */
function looksLikeError(text) {
  if (!text) return false;
  const head = text.slice(0, 400);
  return (
    /\[exit code: [1-9]/.test(head) ||
    /^\s*(Error|ERROR|Failed|FAILED|Exception|Traceback)\b/m.test(head) ||
    /\bcommand not found\b/.test(head) ||
    /\bEACCES\b|\bEPERM\b|\bENOENT\b/.test(head) ||
    /sandbox: file access denied/.test(head)
  );
}

module.exports = { DshAnalyzer, SessionState, SESSIONS_ROOT, decodeWorkspaceSlug, looksLikeError };
