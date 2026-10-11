// Verify the power-mode mapping and labels across all states the collector emits.
const labels = require('../lib/labels');

const cases = [
  { mode: 'charging', watts: 12.34, source: 'battery-charge-rate' },
  { mode: 'discharging', watts: 6.09, source: 'battery-discharge-rate' },
  { mode: 'ac-idle', watts: 0, source: 'battery-flags' },
  { mode: 'unknown', watts: null, source: 'none' },
  { mode: 'none', watts: null, source: 'none' },
  null,
  undefined,
];

console.log('mode          watts    text     label                    tone');
console.log('-'.repeat(78));
for (const p of cases) {
  const f = labels.formatPower(p);
  const mode = p ? p.mode : '(null)';
  console.log(
    `${String(mode).padEnd(13)} ${String(p && p.watts !== null && p.watts !== undefined ? p.watts : '-').padEnd(8)} ` +
    `${f.text.padEnd(8)} ${f.label.padEnd(24)} ${f.tone}`
  );
}

// The charging case must report the input power as a positive number, and the
// label must say it is input power rather than plain "power".
const charging = labels.formatPower({ mode: 'charging', watts: 12.34 });
console.log('\ncharging assertions:');
console.log(`  text is "12.34":        ${charging.text === '12.34'}`);
console.log(`  label mentions 输入:    ${/输入/.test(charging.label)}`);
console.log(`  note mentions ChargeRate: ${/ChargeRate/.test(charging.note)}`);
console.log(`  tone is charging:       ${charging.tone === 'charging'}`);

const discharging = labels.formatPower({ mode: 'discharging', watts: 6.09 });
console.log('discharging assertions:');
console.log(`  text is "6.09":         ${discharging.text === '6.09'}`);
console.log(`  label mentions 放电:    ${/放电/.test(discharging.label)}`);

const idle = labels.formatPower({ mode: 'ac-idle', watts: 0 });
console.log('ac-idle assertions:');
console.log(`  text is "0.00":         ${idle.text === '0.00'}`);
console.log(`  note explains why:      ${/充满|涓流/.test(idle.note)}`);

console.log('\nDSH role labels:');
for (const r of ['dsh-host', 'subagent', 'sandbox', 'dsh-other', 'node', 'weird']) {
  console.log(`  ${r.padEnd(12)} -> ${labels.dshRoleLabel(r)}`);
}
