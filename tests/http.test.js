// Diagnose why the page renders as unstyled text.
//
// Checks the exact bytes and headers the browser receives for the HTML and its
// assets: a wrong Content-Type (e.g. text/plain for CSS) is the classic cause of
// "the page shows only text".

const http = require('http');

function get(path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 8080, path, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

(async () => {
  for (const p of ['/', '/styles.css', '/app.js', '/labels.js']) {
    const r = await get(p);
    if (r.error) { console.log(`${p} -> ERROR ${r.error}`); continue; }
    console.log(`\n=== ${p} ===`);
    console.log(`  status:       ${r.status}`);
    console.log(`  content-type: ${r.headers['content-type']}`);
    console.log(`  length:       ${r.body.length}`);
    console.log(`  first bytes:  ${JSON.stringify(r.body.subarray(0, 90).toString('utf8'))}`);
  }

  // Inspect the HTML: are the asset links present and correctly spelled?
  const home = await get('/');
  if (!home.error) {
    const html = home.body.toString('utf8');
    console.log('\n=== HTML asset references ===');
    for (const m of html.matchAll(/<link[^>]*>|<script[^>]*>/g)) {
      console.log('  ' + m[0]);
    }
    console.log(`\n  has <link rel="stylesheet">: ${/rel="stylesheet"/.test(html)}`);
    console.log(`  references /styles.css:      ${html.includes('/styles.css')}`);
    console.log(`  references /app.js:          ${html.includes('/app.js')}`);
    console.log(`  references /labels.js:       ${html.includes('/labels.js')}`);
  }
})();
