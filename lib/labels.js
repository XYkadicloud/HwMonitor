'use strict';
/**
 * Localised display strings and the power-state mapping.
 *
 * All Chinese text lives in JavaScript rather than in the PowerShell sampler.
 * That is deliberate: Windows PowerShell 5.1 decodes .ps1 file contents with the
 * system ANSI codepage unless the file carries a UTF-8 BOM, so non-ASCII string
 * literals in the sampler are a latent parse-time hazard (they can even corrupt
 * path literals). Keeping the sampler ASCII-only and translating here removes
 * that entire class of failure.
 *
 * This module is shared by the web front end and the native GUI so both show
 * identical wording for the same state.
 */

/** Human-readable description of each power mode emitted by the collector. */
const POWER_LABELS = {
  charging: '充电输入功率',
  discharging: '放电功率',
  'ac-idle': '已接电源（无充放电电流）',
  unknown: '无功率读数',
  none: '无电池',
};

/** Longer explanation shown under the power figure. */
const POWER_NOTES = {
  charging: '充电输入功率：来自电池充电速率的真实读数（WMI BatteryStatus ChargeRate）。',
  discharging: '整机放电功耗：来自电池放电速率的真实读数（WMI BatteryStatus DischargeRate）。',
  'ac-idle': '已接电源，但电池当前没有充放电电流（通常表示已充满或处于涓流维护状态），因此功率显示为 0。',
  unknown: '电池未报告充/放电速率，无法给出真实功率。',
  none: '此设备没有可读的电池功耗数据。',
};

/** Colour role for a power mode, so both UIs agree. */
const POWER_TONE = {
  charging: 'charging',
  discharging: 'discharging',
  'ac-idle': 'idle',
  unknown: 'dim',
  none: 'dim',
};

function powerLabel(mode) {
  return POWER_LABELS[mode] || POWER_LABELS.unknown;
}

function powerNote(mode) {
  return POWER_NOTES[mode] || '';
}

function powerTone(mode) {
  return POWER_TONE[mode] || 'dim';
}

/** Label for a DSH process role, as detected by the sampler. */
const DSH_ROLE_LABELS = {
  'dsh-host': '主进程',
  subagent: '子代理',
  sandbox: '沙箱',
  'dsh-other': 'DSH',
  node: 'node',
};

function dshRoleLabel(role) {
  return DSH_ROLE_LABELS[role] || role;
}

/**
 * Format a power reading for display.
 * @returns {{text: string, label: string, note: string, tone: string, hasValue: boolean}}
 */
function formatPower(power) {
  if (!power) {
    return { text: '—', label: POWER_LABELS.unknown, note: '', tone: 'dim', hasValue: false };
  }
  const hasValue = power.watts !== null && power.watts !== undefined && isFinite(power.watts);
  return {
    text: hasValue ? Number(power.watts).toFixed(2) : '—',
    label: powerLabel(power.mode),
    note: powerNote(power.mode),
    tone: powerTone(power.mode),
    hasValue,
  };
}

// Exported both as a CommonJS module (for the server, the native GUI and tests)
// and as a browser global. The same file is served to the browser by the
// /labels.js route in server.js, so the dashboard and the native GUI share one
// source of truth for wording.
const HWM_LABELS = {
  POWER_LABELS,
  POWER_NOTES,
  POWER_TONE,
  DSH_ROLE_LABELS,
  powerLabel,
  powerNote,
  powerTone,
  dshRoleLabel,
  formatPower,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HWM_LABELS;
}
if (typeof window !== 'undefined') {
  window.HWM_LABELS = HWM_LABELS;
}
