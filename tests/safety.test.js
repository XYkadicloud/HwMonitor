// Safety test: verify that the service manager's stop logic is correct.
//
// THIS TEST MUST NEVER ACTUALLY STOP DSH.
//
// DSH hosts the session that runs this project, and on this machine it is often
// operated remotely: if DSH is terminated, someone has to walk up to the keyboard
// to bring it back. An earlier version of this test called services.stop('dsh')
// directly. That was harmless while DSH was policy-protected, but became actively
// dangerous once the user disabled that protection: the call would have killed the
// session running the test.
//
// The test therefore adapts to the current policy:
//
//   * If DSH is protected (safety.neverStop contains "dsh"), the real stop() is
//     called and must be refused. This is safe because the guard returns before
//     any kill is attempted, and the DSH PID is asserted unchanged afterwards.
//   * If DSH is NOT protected, stop() is only ever exercised in dry-run mode, so
//     nothing is terminated, and the dry-run result is inspected instead.
//
// Run: node tests/safety.test.js

const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const services = require(path.join(LIB, 'services'));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

(async () => {
  const dshProtected = services.isNeverStop('dsh');

  console.log('=== policy configuration ===');
  console.log(`  NEVER_STOP = {${[...services.NEVER_STOP].join(', ')}}`);
  console.log(`  DSH protected: ${dshProtected ? 'YES' : 'NO'}`);
  check('HwMonitor is stoppable', !services.isNeverStop('hwmonitor'));
  check('FRPC is stoppable', !services.isNeverStop('frpc'));

  console.log('\n=== current state (before) ===');
  const before = await services.status('dsh');
  console.log(`  DSH running=${before.running} pid=${before.pid} ports=${before.ports.map((p) => p.port + (p.open ? 'Y' : 'N')).join(' ')}`);
  check('DSH is running before the test', before.running, `pid=${before.pid}`);

  if (dshProtected) {
    console.log('\n=== DSH is protected: stop() must be refused ===');
    // Safe: the policy guard returns before any process is touched.
    const stopResult = await services.stop('dsh');
    check('stop("dsh") reports policyBlocked', stopResult.policyBlocked === true,
      `policyBlocked=${stopResult.policyBlocked}`);
    check('stop("dsh") killed nothing', stopResult.killed.length === 0,
      `killed=[${stopResult.killed.join(',')}]`);
    check('stop("dsh") explains why', /受保护|neverStop/.test(stopResult.reason || ''),
      stopResult.reason);
  } else {
    console.log('\n=== DSH is NOT protected by policy: verify with dry-run only ===');
    // Dry-run computes the would-kill set without terminating anything. This is
    // the only safe way to inspect stop behaviour for an unprotected DSH.
    //
    // Note the second line of defence that shows up here: DSH is an ancestor of
    // this process (it hosts the session), so the ancestry guard refuses to kill
    // it even with policy protection disabled. Either outcome is a pass:
    //   * wouldKill listed  -> dry-run resolved a target set
    //   * blocked/refused   -> the ancestry guard caught it
    const dry = await services.stop('dsh', { dryRun: true });
    const ancestryBlocked = (dry.blocked && dry.blocked.length > 0) || /祖先|自身/.test(dry.reason || '');
    check('dry-run either lists targets or is refused by the ancestry guard',
      !!dry.wouldKill || ancestryBlocked || dry.reason === '未在运行',
      dry.reason);
    check('dry-run killed nothing', !dry.killed || dry.killed.length === 0);
    console.log(`      ${dry.reason}`);
    if (ancestryBlocked) {
      console.log('      (ancestry guard active: DSH hosts this session and was not touched)');
    } else {
      console.log('      (no process was terminated; a real DSH stop would end this session)');
    }
  }

  console.log('\n=== DSH must still be alive with the same PID ===');
  const after = await services.status('dsh');
  check('DSH still running', after.running === true);
  check('DSH PID unchanged', after.pid === before.pid, `${before.pid} -> ${after.pid}`);
  check('DSH ports still listening', after.ports.every((p) => p.open));

  console.log('\n=== stopAll() must not terminate DSH ===');
  const allResults = await services.stopAll({ dryRun: true });
  const dshResult = allResults.find((r) => r.key === 'dsh');
  check('stopAll includes a dsh entry', !!dshResult);
  if (dshProtected) {
    check('stopAll marks dsh as policyBlocked', dshResult && dshResult.policyBlocked === true);
  } else {
    check('stopAll dry-run did not kill dsh',
      dshResult && (!dshResult.killed || dshResult.killed.length === 0),
      dshResult ? dshResult.reason : '');
  }
  check('stopAll killed nothing (dry run)',
    allResults.every((r) => !r.killed || r.killed.length === 0));
  for (const r of allResults) {
    const tag = r.policyBlocked ? 'PROTECTED' : (r.dryRun ? 'dry-run' : 'n/a');
    console.log(`      ${r.key.padEnd(11)} ${tag.padEnd(10)} ${r.reason}`);
  }

  console.log('\n=== dry-run for a stoppable service reports a would-kill set ===');
  const dryFrpc = await services.stop('frpc', { dryRun: true });
  console.log(`      frpc dry-run: ${dryFrpc.reason}`);
  check('dry-run did not kill anything', !dryFrpc.killed || dryFrpc.killed.length === 0);

  console.log('\n=== final state (nothing may have been terminated) ===');
  const finalAll = await services.statusAll();
  for (const s of finalAll) {
    console.log(`      ${s.name.padEnd(11)} running=${s.running} pid=${s.pid}`);
  }
  const dshFinal = finalAll.find((s) => s.key === 'dsh');
  check('DSH survived the entire safety test', dshFinal.running === true, `pid=${dshFinal.pid}`);
  check('DSH PID still equals the original', dshFinal.pid === before.pid,
    `${before.pid} -> ${dshFinal.pid}`);

  console.log(`\n${failures === 0 ? 'ALL SAFETY CHECKS PASSED' : failures + ' SAFETY CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
