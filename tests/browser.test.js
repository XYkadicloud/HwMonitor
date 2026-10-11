// Verify the browser scripts parse and that the shared labels module works in a
// browser-like context.
//
// This replaces a headless-browser check that proved unreliable on this machine
// (Chrome's --screenshot/--dump-dom would intermittently hang). Running the
// scripts in a vm sandbox with a minimal window/document stub catches the
// realistic failure modes: syntax errors, a missing global, and the labels
// module failing to attach itself to window.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// --- 1. Syntax check every browser script -------------------------------
console.log('=== syntax ===');
for (const f of ['public/app.js', 'lib/labels.js']) {
  const full = path.join(ROOT, f);
  try {
    new vm.Script(fs.readFileSync(full, 'utf8'), { filename: full });
    check(`${f} parses`, true);
  } catch (e) {
    check(`${f} parses`, false, e.message);
  }
}

// --- 2. labels.js must attach itself to window --------------------------
console.log('\n=== labels.js in a browser-like context ===');
const sandbox = {
  window: {},
  console: { log() {}, warn() {}, error() {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'labels.js'), 'utf8'), sandbox, {
    filename: 'labels.js',
  });
} catch (e) {
  check('labels.js executes without a CommonJS module present', false, e.message);
}

check('window.HWM_LABELS exists', !!(sandbox.window && sandbox.window.HWM_LABELS));
if (sandbox.window && sandbox.window.HWM_LABELS) {
  const L = sandbox.window.HWM_LABELS;
  check('powerLabel is a function', typeof L.powerLabel === 'function');
  check('dshRoleLabel is a function', typeof L.dshRoleLabel === 'function');
  check('charging label correct', L.powerLabel('charging') === '充电输入功率',
    L.powerLabel('charging'));
  check('discharging label correct', L.powerLabel('discharging') === '放电功率');
  check('ac-idle label correct', /已接电源/.test(L.powerLabel('ac-idle')));
  check('unknown mode falls back', L.powerLabel('nonsense') === '无功率读数');
  check('formatPower returns text', L.formatPower({ mode: 'charging', watts: 5.5 }).text === '5.50');
  check('formatPower handles null', L.formatPower(null).text === '—');
}

// --- 3. index.html must load labels.js before app.js --------------------
console.log('\n=== index.html script order ===');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const labelsAt = html.indexOf('src="/labels.js"');
const appAt = html.indexOf('src="/app.js"');
check('labels.js is referenced', labelsAt >= 0);
check('app.js is referenced', appAt >= 0);
check('labels.js loads before app.js', labelsAt >= 0 && appAt >= 0 && labelsAt < appAt,
  `labels@${labelsAt} app@${appAt}`);

// --- 4. app.js must not reference undefined label helpers --------------
console.log('\n=== app.js label usage ===');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const used = [...new Set((app.match(/HWM_LABELS\.(\w+)/g) || []).map((s) => s.split('.')[1]))];
check('app.js uses HWM_LABELS', used.length > 0, used.join(', '));
const provided = ['powerLabel', 'powerNote', 'powerTone', 'dshRoleLabel', 'formatPower',
  'POWER_LABELS', 'POWER_NOTES', 'POWER_TONE', 'DSH_ROLE_LABELS'];
for (const u of used) {
  check(`HWM_LABELS.${u} is provided`, provided.includes(u));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
