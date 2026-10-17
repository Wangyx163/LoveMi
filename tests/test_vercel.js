'use strict';
// Test the platform adapters and static output locally without a paid model call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {Readable} = require('node:stream');
const {spawnSync} = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'public');
const LIMIT = 256 * 1024;
const savedEnv = {MODEL_API_KEY: process.env.MODEL_API_KEY, MODEL_API_BASE: process.env.MODEL_API_BASE};
process.env.MODEL_API_KEY = 'vercel-test-key';
let upstream, platform;
function filesIn(directory, prefix = '') {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const relative = prefix + entry.name;
    assert(!entry.isSymbolicLink(), 'generated output must not contain symlinks');
    return entry.isDirectory() ? filesIn(path.join(directory, entry.name), relative + '/') : [relative];
  }).sort();
}
function runBuild() {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-public.js')], {cwd: ROOT, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function stream(chunks) { const req = Readable.from(chunks); req.headers = {}; return req; }
async function expectStatus(promise, status) { await assert.rejects(promise, error => error.status === status); }
(async () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'public');
  assert.equal(config.buildCommand, 'node scripts/build-public.js');
  assert.equal(config.fluid, true);
  assert.equal(config.functions['api/*.js'].includeFiles, '{config/models.json,.env}');
  assert(config.functions['api/*.js'].maxDuration > 180, 'platform duration must leave room after the deep-thinking timeout');
  assert(config.functions['api/*.js'].maxDuration <= 300, 'duration must fit Fluid Hobby limits');
  runBuild();
  fs.writeFileSync(path.join(OUTPUT, 'should-not-deploy.txt'), 'stale output');
  runBuild();
  const files = filesIn(OUTPUT);
  for (const relative of ['index.html', 'local_model_client.js', 'src/engine.js', 'data/config.json', 'data/prompts.json', 'debug/index.html', 'assets/app.js', 'assets/app.css', 'assets/lovemi-cat-wave.png']) {
    assert(files.includes(relative), relative + ' must be deployed');
  }
  for (const relative of files) {
    assert(/^(?:index\.html|local_model_client\.js|src\/engine\.js|data\/(?:config|prompts)\.json|LoveMi_在线测试版_v1\.9\.html|debug\/index\.html|assets\/(?:[a-z0-9][a-z0-9_.-]*\/)*[a-z0-9][a-z0-9_.-]*\.(?:css|js|png|webp|svg|jpe?g|ico))$/i.test(relative), 'unexpected public file: ' + relative);
  }
  for (const relative of ['.env', '.env.example', 'server.js', 'config/models.json', 'package.json', 'README.md', 'tests/test_vercel.js', 'assets/README.md', 'should-not-deploy.txt']) {
    assert(!files.includes(relative), relative + ' must not be public');
  }
  const keyMatch = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MODEL_API_KEY\s*=\s*(.+)$/m);
  if (keyMatch) {
    const privateKey = keyMatch[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    for (const relative of files.filter(file => /\.(?:html|js|json|css|svg)$/i.test(file))) {
      assert(!fs.readFileSync(path.join(OUTPUT, relative), 'utf8').includes(privateKey), 'private key leaked into public build');
    }
  }
  let lastRequest;
  upstream = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer vercel-test-key', 'deployment environment must override .env');
    let raw = '';
    req.setEncoding('utf8'); req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      lastRequest = JSON.parse(raw);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content: '{"ack":"中文完整～"}'}}]}));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.MODEL_API_BASE = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const gateway = require('../server');
  const model = require('../api/model');
  const status = require('../api/status');
  assert.equal(model, gateway.requestHandler);
  assert.equal(status, gateway.requestHandler);
  assert.equal(gateway.server.listening, false, 'importing a function must not start an HTTP listener');
  const input = {pid: 'P6', sys: '你是 LoveMi 🐱', user: '一起吃饭，认真沟通。'};
  const encoded = Buffer.from(JSON.stringify(input));
  for (const body of [input, encoded.toString(), encoded]) assert.deepEqual(await gateway.readJson({headers: {}, body}), input);
  // Split every UTF-8 code point across chunks to catch destructive per-chunk decoding.
  assert.deepEqual(await gateway.readJson(stream([...encoded].map(byte => Buffer.from([byte])))), input);
  assert.deepEqual(await gateway.readJson(stream([encoded.toString()])), input);
  await expectStatus(gateway.readJson({headers: {}, get body() { throw new Error('platform JSON parse error'); }}), 400);
  for (const body of ['{', Buffer.from('{'), {text: '你'.repeat(90000)}, ' '.repeat(LIMIT + 1), Buffer.alloc(LIMIT + 1)]) {
    await expectStatus(gateway.readJson({headers: {}, body}), body.length === 1 ? 400 : 413);
  }
  await expectStatus(gateway.readJson(stream([Buffer.alloc(LIMIT), Buffer.from('x') ])), 413);
  await expectStatus(gateway.readJson({headers: {'content-length': String(LIMIT + 1)}, body: {}}), 413);
  const circular = {}; circular.self = circular;
  await expectStatus(gateway.readJson({headers: {}, body: circular}), 400);
  // Emulate Vercel's already-consumed request stream and body getter on real HTTP.
  platform = http.createServer(async (req, res) => {
    const route = req.url.split('?')[0];
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const format = req.headers['x-test-body'] || 'object';
      if (format === 'string') req.body = raw.toString('utf8');
      else if (format === 'buffer') req.body = raw;
      else Object.defineProperty(req, 'body', {get() { return JSON.parse(raw.toString('utf8')); }});
    }
    await (route === '/api/status' ? status : model)(req, res);
  });
  await new Promise(resolve => platform.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + platform.address().port;
  for (const format of ['object', 'string', 'buffer']) {
    const response = await fetch(base + '/api/model', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: base, 'x-test-body': format}, body: encoded});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).text, '{"ack":"中文完整～"}');
    assert.equal(lastRequest.messages[1].content, input.user);
    assert.equal(lastRequest.enable_thinking, true);
  }
  const malformed = await fetch(base + '/api/model', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{'});
  assert.equal(malformed.status, 400);
  const oversized = await fetch(base + '/api/model', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({pid: 'P6', sys: '你'.repeat(90000), user: 'test'})});
  assert.equal(oversized.status, 413);
  const response = await fetch(base + '/api/status'); const health = await response.json();
  assert.equal(health.ok, true); assert.equal(health.key_configured, true);
  assert.equal(health.api_base, process.env.MODEL_API_BASE);
  assert(!JSON.stringify(health).includes('vercel-test-key'));
  delete process.env.MODEL_API_KEY;
  const noKey = await fetch(base + '/api/model', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: encoded});
  assert.equal(noKey.status, 503, 'missing deployment credentials must report a configuration error');
  const noKeyHealth = await (await fetch(base + '/api/status')).json();
  assert.equal(noKeyHealth.key_configured, false);
  process.env.MODEL_API_KEY = 'vercel-test-key';
  assert.equal(gateway.server.listening, false);
  console.log('✓ Vercel 适配通过：函数入口、预解析请求、UTF-8 与体积限制、环境覆盖、公开构建白名单与密钥隔离');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const server of [platform, upstream]) {
    if (server?.listening) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  }
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
