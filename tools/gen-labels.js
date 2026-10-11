// Generate lib/labels.json: display strings for the native window.
//
// Rationale: ps/native-window.ps1 must stay pure ASCII because Windows
// PowerShell 5.1 decodes a non-BOM .ps1 with the system ANSI codepage, and this
// project sits under a path containing Chinese characters. Localised text is
// therefore externalised here (written as UTF-8 by Node) and read at runtime.
//
// Run: node tools/gen-labels.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const STRINGS = {
  title: '硬件与 DSH 监控',
  'mode.server': '已连接服务',
  'mode.embedded': '独立采样',
  'mode.offline': '离线',
  waiting: '正在等待数据…',

  battery: '电池',
  cpu: 'CPU',
  memory: '内存',
  gpu: 'GPU',

  remaining: '剩余容量',
  health: '健康度',
  cycles: '循环次数',
  cores: '核心/线程',
  freq: '频率',
  user: '用户态',
  used: '已用',
  avail: '可用',
  total: '总共',
  engines: '引擎数',
  ok: '正常',
  unsupported: '不支持',

  power: '功耗',
  runtime: '预计续航',

  disks: '磁盘容量',
  throughput: '吞吐',
  disk: '磁盘',
  net: '网络',
  topProcesses: '占用最高的进程',

  // Service control panel. The window doubles as the control panel so a separate
  // TUI is not needed to start or stop services.
  services: '服务控制',
  start: '启动',
  stop: '停止',
  restart: '重启',
  startAll: '全部启动',
  stopAll: '全部停止',
  working: '正在执行',
  done: '已完成',
  failed: '失败',
  openWeb: '网页版',
};

const out = path.join(ROOT, 'lib', 'labels.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
// Explicit UTF-8 (no BOM) so PowerShell reads it correctly via ReadAllText with
// an explicit encoding, independent of the console codepage.
fs.writeFileSync(out, JSON.stringify(STRINGS, null, 2), 'utf8');

console.log(`wrote ${out}`);
console.log(`  ${Object.keys(STRINGS).length} strings`);
