// Verify the SSE endpoint streams events over a real HTTP connection.
const http = require('http');

const started = Date.now();
const events = [];
let raw = '';

const req = http.get('http://127.0.0.1:8080/api/stream', (res) => {
  console.log(`status: ${res.statusCode}`);
  console.log(`content-type: ${res.headers['content-type']}`);
  console.log(`cache-control: ${res.headers['cache-control']}`);

  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    raw += chunk;
    let i;
    while ((i = raw.indexOf('\n\n')) >= 0) {
      const block = raw.slice(0, i);
      raw = raw.slice(i + 2);
      if (!block.trim() || block.startsWith(':')) continue;
      let name = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      let parsed = null;
      try { parsed = JSON.parse(data); } catch {}
      events.push({ at: Date.now() - started, name, size: data.length, parsed });
    }
  });
});

setTimeout(() => {
  req.destroy();
  console.log(`\nelapsed: ${Date.now() - started}ms`);
  console.log(`events received: ${events.length}`);

  const counts = {};
  for (const e of events) counts[e.name] = (counts[e.name] || 0) + 1;
  console.log('event types: ' + JSON.stringify(counts));

  for (const e of events.slice(0, 6)) {
    let extra = '';
    if (e.name === 'hello' && e.parsed) {
      extra = e.parsed.collector
        ? ` [full state: collector.healthy=${e.parsed.collector.healthy}, inventory=${e.parsed.inventory ? 'yes' : 'no'}]`
        : e.parsed.static ? ` [collector hello: cpu=${e.parsed.static.cpuName}]` : '';
    }
    if (e.name === 'sample' && e.parsed) {
      extra = ` [seq=${e.parsed.seq} cpu=${e.parsed.cpu ? e.parsed.cpu.totalPct : '-'}% bat=${e.parsed.battery ? e.parsed.battery.percent : '-'}%]`;
    }
    console.log(`  +${String(e.at).padStart(5)}ms  ${e.name.padEnd(16)} ${String(e.size).padStart(6)} bytes${extra}`);
  }

  const samples = events.filter((e) => e.name === 'sample');
  console.log(`\nsample events: ${samples.length}`);
  if (samples.length >= 2) {
    const gaps = [];
    for (let i = 1; i < samples.length; i++) gaps.push(samples[i].at - samples[i - 1].at);
    console.log(`sample intervals: ${gaps.join(', ')} ms (configured 2000)`);
  }
  const hello = events.find((e) => e.name === 'hello');
  console.log(`hello delivered: ${hello ? 'yes' : 'NO'}`);
  console.log(`\nRESULT: ${events.length > 0 && hello ? 'SSE WORKING' : 'SSE BROKEN'}`);
}, 9000);
