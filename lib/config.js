'use strict';
/**
 * Persistent configuration for HwMonitor.
 *
 * Stored as JSON next to the app so the user can edit pricing, thresholds and
 * access settings without touching code. Writes are atomic (temp file + rename)
 * to avoid leaving a truncated config behind if the process dies mid-write.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');

/**
 * Pricing is expressed per 1,000,000 tokens. Rates default to 0 rather than to
 * guessed vendor prices: an invented number would silently produce wrong cost
 * figures. The UI makes these editable and clearly flags unpriced models.
 */
const DEFAULT_CONFIG = {
  port: 8080,
  // Bind on all interfaces so phones/tablets on the same Wi-Fi can connect.
  host: '0.0.0.0',
  // Empty password means "no login required". Set by the setup flow / UI.
  password: '',
  refreshMs: 2000,
  historyMinutes: 15,
  /**
   * Safety policy.
   *
   * `neverStop` lists services this tooling must never stop or restart. DSH is
   * listed by default and deliberately: this machine is frequently operated
   * remotely, and terminating DSH would end the session with no way to bring it
   * back without someone physically at the keyboard. Only the user may close it.
   *
   * Removing "dsh" here is the single, explicit opt-out. When this key is absent
   * or unreadable the default is still to protect DSH.
   */
  safety: {
    neverStop: ['dsh'],
  },
  /**
   * frp tunnel endpoints, for display only.
   *
   * Kept in configuration rather than hard-coded because a tunnel's server address
   * and public ports belong to one specific deployment. Publishing them in a
   * public repository would advertise how to reach this machine, so the default is
   * empty and the UI omits the tunnel table entirely when nothing is configured.
   *
   * Example (replace with your own values):
   *   "tunnels": [
   *     { "name": "HwMonitor", "local": "127.0.0.1:8080", "remote": "example.com:18080" }
   *   ]
   */
  tunnels: [],
  thresholds: {
    batteryLowPct: 20,
    diskLowFreePct: 10,
    cpuHighPct: 90,
    memoryHighPct: 90,
  },
  pricing: {
    // currency label only; no conversion is performed
    currency: 'CNY',
    // Per-million-token rates. Keyed by "provider/model".
    models: {
      'workbuddy/deepseek-v4.1-flash': {
        input: 0, output: 0, cacheRead: 0, reasoning: 0,
      },
      'gemini/gemini-3.8-flash': {
        input: 0, output: 0, cacheRead: 0, reasoning: 0,
      },
    },
    // Fallback rates applied to any model not listed above.
    defaultRates: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
  },
};

function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return override;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class Config {
  constructor() {
    this.path = CONFIG_PATH;
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      return deepMerge(DEFAULT_CONFIG, parsed);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error(`[config] could not read ${this.path}: ${e.message}; using defaults`);
      }
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  save() {
    ensureDir(path.dirname(this.path));
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.path);
  }

  get(key) {
    return this.data[key];
  }

  /** Apply a partial patch, persist, and return the merged config. */
  update(patch) {
    this.data = deepMerge(this.data, patch);
    // Guard against unusable values arriving from the UI.
    this.data.port = clampInt(this.data.port, 1, 65535, 8080);
    this.data.refreshMs = clampInt(this.data.refreshMs, 250, 60000, 2000);
    this.data.historyMinutes = clampInt(this.data.historyMinutes, 1, 1440, 15);
    this.save();
    return this.data;
  }
}

function clampInt(v, lo, hi, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Resolve the rate card for a provider/model pair, falling back to defaults.
 * Returns a zero-rate card (and `priced: false`) when nothing is configured, so
 * callers can show "unpriced" instead of a misleading 0.00 cost.
 */
function ratesFor(cfg, provider, model) {
  const key = `${provider}/${model}`;
  const models = (cfg && cfg.pricing && cfg.pricing.models) || {};
  const def = (cfg && cfg.pricing && cfg.pricing.defaultRates) || {};
  const found = models[key];
  const rates = found || def;
  const r = {
    input: num(rates.input),
    output: num(rates.output),
    cacheRead: num(rates.cacheRead),
    reasoning: num(rates.reasoning),
  };
  const priced = r.input > 0 || r.output > 0 || r.cacheRead > 0 || r.reasoning > 0;
  return { key, rates: r, priced, source: found ? 'model' : 'default' };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

module.exports = { Config, DEFAULT_CONFIG, CONFIG_PATH, ROOT, ratesFor, deepMerge };
