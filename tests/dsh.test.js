// Verify the DSH analyzer against real session logs.
const { DshAnalyzer } = require('../lib/dsh');
const { ratesFor } = require('../lib/config');

const a = new DshAnalyzer();
console.log('=== first (cold) scan ===');
const ms1 = a.scan();
console.log(`cold scan: ${ms1}ms, bytes read: ${a.totalBytesRead}`);
console.log(`sessions discovered: ${a.sessions.size}`);

console.log('\n=== second (warm, no changes) scan ===');
const ms2 = a.scan();
console.log(`warm scan: ${ms2}ms, bytes read: ${a.totalBytesRead} (should be unchanged)`);

console.log('\n=== incremental scan must not double-count ===');
const before = {};
for (const [k, st] of a.sessions) before[k] = st.totalTokens;
const ms3 = a.scan();
let drift = 0;
for (const [k, st] of a.sessions) {
  const b = before[k];
  const n = st.totalTokens;
  if (b && (b.input !== n.input || b.output !== n.output || b.calls !== n.calls)) {
    drift++;
    console.log(`  DRIFT in ${k}: in ${b.input}->${n.input} out ${b.output}->${n.output}`);
  }
}
console.log(`sessions with drift after re-scan: ${drift} (expect 0)`);

const cfg = { pricing: { currency: 'CNY', models: {}, defaultRates: { input: 1, output: 2, cacheRead: 0.1, reasoning: 0 } } };
const rep = a.report(cfg, ratesFor);

console.log('\n=== GRAND TOTALS ===');
console.log(JSON.stringify(rep.grand, null, 2));

console.log('\n=== BY MODEL ===');
for (const m of rep.byModel) {
  console.log(`  ${m.provider}/${m.model}: calls=${m.calls} in=${m.inputTokens} out=${m.outputTokens} reasoning=${m.reasoningTokens} cacheRead=${m.cacheReadTokens} cost=${m.cost.toFixed(4)}`);
}

console.log('\n=== TOP TOOLS ===');
console.log('  ' + rep.byTool.slice(0, 12).map((t) => `${t.name}=${t.count}`).join('  '));

console.log('\n=== SESSIONS (top 5 by recency) ===');
for (const s of rep.sessions.slice(0, 5)) {
  console.log(`  ${s.id.slice(0, 20)} | ${(s.title || '(untitled)').slice(0, 34).padEnd(34)} | turns=${String(s.turns).padStart(3)} steps=${String(s.steps).padStart(4)} events=${String(s.eventCount).padStart(5)} in=${String(s.tokens.input).padStart(8)} out=${String(s.tokens.output).padStart(7)} tools=${s.tools.length} active=${s.active}`);
  console.log(`      cwd=${s.cwd}`);
}

const cur = a.currentSession();
console.log('\n=== CURRENT SESSION ===');
if (cur) {
  const cs = a.summarize(cur, cfg, ratesFor);
  console.log(`  id=${cs.id}`);
  console.log(`  title=${cs.title}`);
  console.log(`  active=${cs.active} lastTurn=${cs.lastTurn} lastStep=${cs.lastStep}`);
  console.log(`  models=${cs.models.map((m) => m.provider + '/' + m.model).join(', ')}`);
  console.log(`  goal=${cs.goal ? cs.goal.objective.slice(0, 70) + ' [' + cs.goal.status + ']' : 'none'}`);
  console.log(`  todos=${cs.todos ? cs.todos.length + ' items' : 'none'}`);
  console.log(`  recent tools: ${cs.recentTools.slice(-6).map((t) => t.name).join(', ')}`);
  console.log(`  recent errors: ${cs.recentErrors.length}`);
  console.log(`  turn end kinds: ${JSON.stringify(cs.turnEndKinds)}`);
}

console.log('\n=== byDay ===');
console.log(JSON.stringify(rep.byDay, null, 2));

console.log('\n=== workspace slug decode check ===');
const { decodeWorkspaceSlug } = require('../lib/dsh');
for (const s of ['--C-Users-User-Desktop--', '--E-android2.3.6~0020dev~0020app--', '--C-Users-User-Documents-deepseek-harness-default-workspace--']) {
  console.log(`  ${s} -> ${decodeWorkspaceSlug(s)}`);
}

console.log('\n=== scan cost over 5 warm scans ===');
const t0 = Date.now();
for (let i = 0; i < 5; i++) a.scan();
console.log(`  5 warm scans: ${Date.now() - t0}ms total`);
