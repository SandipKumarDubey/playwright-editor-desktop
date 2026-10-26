#!/usr/bin/env node
// Runner for the Playwright editor.
// Used two ways: `node server.js` (browser tab) or started by main.js inside the desktop app.
// It only listens on 127.0.0.1 and only accepts requests from its own page, because it runs code.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const TIMEOUT_MS = 120000;
const KEEP_RUNS = 10;
const MAX_BODY = 1024 * 1024;
const BROWSERS = ['chromium', 'firefox', 'webkit', 'msedge', 'chrome'];
const CHANNELS = ['msedge', 'chrome'];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const stripAnsi = s => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function tryResolve(id) {
  try { return require.resolve(id, { paths: [ROOT] }); } catch (_) { return null; }
}
function playwrightInfo() {
  const cli = tryResolve('@playwright/test/cli') || tryResolve('playwright/cli');
  let version = '';
  const pkg = tryResolve('@playwright/test/package.json') || tryResolve('playwright/package.json');
  if (pkg) { try { version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version; } catch (_) {} }
  return { cli, version };
}
function pythonCmd() {
  for (const c of ['python3', 'python']) {
    const r = spawnSync(c, ['-m', 'pytest', '--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
}
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch (_) { try { child.kill('SIGKILL'); } catch (__) {} }
}

function cleanOptions(b) {
  const lang = ['js', 'ts', 'py'].includes(b.lang) ? b.lang : null;
  const browser = BROWSERS.includes(b.browser) ? b.browser : 'chromium';
  const slowMo = Math.min(5000, Math.max(0, Number(b.slowMo) || 0));
  let url = '';
  if (b.url && String(b.url).trim()) {
    const u = new URL(String(b.url).trim());           // throws on junk
    if (!/^https?:$/.test(u.protocol)) throw new Error('URL must start with http:// or https://');
    url = u.href;
  }
  if (!lang) throw new Error('Unknown language');
  if (typeof b.code !== 'string' || !b.code.trim()) throw new Error('There is no code to run');
  return { lang, browser, slowMo, url, headed: !!b.headed, code: b.code };
}

// opts: { port, runsDir, nodePath, desktop }  ->  Promise<{ port, close() }>
function start(opts = {}) {
  const RUNS = opts.runsDir || path.join(ROOT, 'runs');
  const desktop = !!opts.desktop;
  fs.mkdirSync(RUNS, { recursive: true });
  const active = new Set();
  let allowedHosts = new Set(), allowedOrigins = new Set();

  function childEnv() {
    const env = { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never', PYTHONUNBUFFERED: '1' };
    delete env.NO_COLOR; delete env.FORCE_COLOR;
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';   // run Electron's bundled Node
    if (opts.nodePath) env.NODE_PATH = opts.nodePath + (env.NODE_PATH ? path.delimiter + env.NODE_PATH : '');
    return env;
  }
  function pruneRuns() {
    try {
      const dirs = fs.readdirSync(RUNS)
        .map(n => ({ n, t: fs.statSync(path.join(RUNS, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t).slice(KEEP_RUNS);
      for (const d of dirs) fs.rmSync(path.join(RUNS, d.n), { recursive: true, force: true });
    } catch (_) {}
  }
  function collectShots(dir, id) {
    const out = [];
    (function walk(d, depth) {
      if (depth > 4 || out.length >= 20) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.png$/i.test(e.name)) out.push('/runs/' + id + '/' + path.relative(dir, p).split(path.sep).map(encodeURIComponent).join('/'));
      }
    })(dir, 0);
    return out;
  }

  function startRun(o, res) {
    const id = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const dir = path.join(RUNS, id);
    fs.mkdirSync(dir, { recursive: true });
    pruneRuns();
    const send = x => { if (!res.writableEnded) res.write(JSON.stringify(x) + '\n'); };
    const channel = CHANNELS.includes(o.browser) ? o.browser : null;
    let cmd, args, label;

    if (o.lang === 'py') {
      const py = pythonCmd();
      if (!py) throw new Error('Python runner not found. Run: pip install pytest-playwright && playwright install');
      fs.writeFileSync(path.join(dir, 'test_run.py'), o.code);
      cmd = py;
      args = ['-m', 'pytest', 'test_run.py', '-p', 'no:cacheprovider', '--browser', channel ? 'chromium' : o.browser,
        '--screenshot', 'on', '--output', 'results'];
      if (channel) args.push('--browser-channel', channel);
      if (o.headed) args.push('--headed');
      if (o.slowMo) args.push('--slowmo', String(o.slowMo));
      if (o.url) args.push('--base-url', o.url);
      label = 'pytest ' + args.slice(2).join(' ');
    } else {
      const { cli } = playwrightInfo();
      if (!cli) throw new Error('Playwright is not installed. Run: npm install');
      const ext = o.lang === 'ts' ? 'ts' : 'js';
      fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
      fs.writeFileSync(path.join(dir, 'user.spec.' + ext), o.code);
      const launch = { slowMo: o.slowMo };
      if (process.env.PW_EXECUTABLE_PATH && !channel && o.browser === 'chromium') launch.executablePath = process.env.PW_EXECUTABLE_PATH;
      const config = `module.exports = {
  testDir: '.',
  timeout: 30000,
  workers: 1,
  reporter: 'line',
  outputDir: './results',
  use: {
    browserName: ${JSON.stringify(channel ? 'chromium' : o.browser)},
    ${channel ? 'channel: ' + JSON.stringify(channel) + ',' : ''}
    headless: ${!o.headed},
    baseURL: ${o.url ? JSON.stringify(o.url) : 'undefined'},
    screenshot: 'on',
    launchOptions: ${JSON.stringify(launch)},
  },
};
`;
      fs.writeFileSync(path.join(dir, 'playwright.config.js'), config);
      cmd = process.execPath;
      args = [cli, 'test', '--config', 'playwright.config.js'];
      label = 'playwright test --config playwright.config.js' + (channel ? '   (' + channel + ')' : '');
    }

    send({ type: 'start', id, command: label });
    const started = Date.now();
    let timedOut = false, finished = false;
    const child = spawn(cmd, args, { cwd: dir, detached: process.platform !== 'win32', windowsHide: true, env: childEnv() });
    active.add(child);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, TIMEOUT_MS);
    const onData = d => send({ type: 'out', text: stripAnsi(d.toString('utf8')) });
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => send({ type: 'out', text: 'Could not start: ' + err.message + '\n' }));
    child.on('close', (code, signal) => {
      finished = true; clearTimeout(timer); active.delete(child);
      send({ type: 'done', code, signal, timedOut, ms: Date.now() - started, shots: collectShots(dir, id) });
      res.end();
    });
    res.on('close', () => { if (!finished) { clearTimeout(timer); killTree(child); } });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!allowedHosts.has(host)) { res.writeHead(403); return res.end('Forbidden host'); }
      const url = new URL(req.url, 'http://' + host);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
        const file = path.resolve(RUNS, '.' + decodeURIComponent(url.pathname).slice('/runs'.length));
        const mime = MIME[path.extname(file).toLowerCase()];
        if (!file.startsWith(RUNS + path.sep) || !mime || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (req.headers['x-pw-runner'] !== '1' || (origin && !allowedOrigins.has(origin))) return json(res, 403, { error: 'Forbidden' });
        if (req.method === 'GET' && url.pathname === '/api/info') {
          const pw = playwrightInfo();
          return json(res, 200, { ok: true, desktop, node: process.versions.node,
            playwright: pw.cli ? pw.version || 'installed' : null, python: desktop ? false : !!pythonCmd() });
        }
        if (req.method === 'POST' && url.pathname === '/api/run') {
          let o;
          try { o = cleanOptions(JSON.parse(await readBody(req))); }
          catch (e) { return json(res, 400, { error: e.message }); }
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          try { return startRun(o, res); }
          catch (e) {
            res.write(JSON.stringify({ type: 'out', text: e.message + '\n' }) + '\n');
            res.write(JSON.stringify({ type: 'done', code: 1, ms: 0, shots: [] }) + '\n');
            return res.end();
          }
        }
      }
      res.writeHead(404); res.end('Not found');
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end('Server error');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
      allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
      resolve({ port, runsDir: RUNS, close() { active.forEach(killTree); server.close(); } });
    });
  });
}

module.exports = { start, playwrightInfo };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  start({ port }).then(() => {
    const pw = playwrightInfo();
    console.log(`\n  Playwright Editor running at  http://localhost:${port}\n`);
    console.log(pw.cli ? `  Playwright ${pw.version || ''} found` : '  Playwright NOT found. Run: npm install');
    console.log('  Press Ctrl+C to stop.\n');
  }).catch(e => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy. Try: PORT=3001 node server.js` : e.message);
    process.exit(1);
  });
}
