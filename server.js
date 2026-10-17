'use strict';
// LoveMi v1.9 reference-flow local gateway. All prompts and routing remain in the original browser engine.
// This gateway only dispatches individual model nodes via an OpenAI-compatible Chat Completions API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = __dirname;
const MAX_BODY_BYTES = 256 * 1024;
const ALLOWED_PIDS = new Set(['P1', 'P1B', 'P3', 'P5', 'P6', 'P7']);
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      let value = match[2].trim();
      if (value.length > 1 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) value = value.slice(1,-1);
      process.env[match[1]] = value;
    }
  }
}
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '127.0.0.1';
function modelConfig() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'models.json'), 'utf8')); }
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function bodyError(status, message) { return Object.assign(new Error(message), {status}); }
async function readJson(req) {
  const length = Number(req.headers?.['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw bodyError(413, '请求体过大');
  const parse = raw => {
    if (raw.length > MAX_BODY_BYTES) throw bodyError(413, '请求体过大');
    try { return JSON.parse(raw.toString('utf8')); }
    catch { throw bodyError(400, 'JSON 格式错误'); }
  };
  // Vercel may have already consumed the stream and exposes body through a getter.
  // Read it once, handle malformed JSON, and apply the same byte limit as locally.
  let body;
  try { body = req.body; }
  catch { throw bodyError(400, 'JSON 格式错误'); }
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) return parse(body);
    if (typeof body === 'string') return parse(Buffer.from(body, 'utf8'));
    let encoded;
    try { encoded = JSON.stringify(body); }
    catch { throw bodyError(400, 'JSON 格式错误'); }
    if (typeof encoded !== 'string') throw bodyError(400, 'JSON 格式错误');
    return parse(Buffer.from(encoded, 'utf8'));
  }
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks = [];
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    req.on('data', chunk => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      size += bytes.length;
      if (size > MAX_BODY_BYTES) return fail(bodyError(413, '请求体过大'));
      chunks.push(bytes);
    });
    req.on('end', () => {
      if (settled) return;
      try { const parsed = parse(Buffer.concat(chunks, size)); settled = true; resolve(parsed); }
      catch (error) { fail(error); }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(bodyError(400, '请求已中断')));
  });
}
function completionText(output) {
  const choice = output?.choices?.[0];
  if (!choice) throw new Error('上游没有返回 choices[0]');
  const content = choice.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(x => x && x.type === 'text').map(x => x.text || '').join('');
  throw new Error('上游未返回可读取的 message.content 文本');
}
function completionURL(provider) {
  const apiBase = process.env.MODEL_API_BASE || provider.api_base;
  if (!apiBase) throw new Error('请配置 config/models.json 的 provider.api_base');
  const url = new URL(apiBase);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('只支持 http(s) 模型端点');
  // Accept both a full /chat/completions endpoint and a .../v1 base URL.
  if (!url.pathname.replace(/\/$/, '').endsWith('/chat/completions')) {
    url.pathname = url.pathname.replace(/\/$/,'') + '/chat/completions';
  }
  return url;
}
async function handleModel(req, res) {
  const input = await readJson(req);
  const pid = input && input.pid;
  if (!ALLOWED_PIDS.has(pid)) return json(res, 400, {error:'模型节点名称无效'});
  if (typeof input.sys !== 'string' || typeof input.user !== 'string' || input.sys.length > 100000 || input.user.length > 100000) return json(res,400,{error:'Prompt 输入无效或长度过大'});
  const config = modelConfig();
  const spec = config.nodes?.[pid];
  if (!spec || typeof spec.model !== 'string' || !spec.model.trim()) return json(res,400,{error:`请先在 config/models.json 设置 ${pid} 的模型名称`});
  const provider = config.provider || {};
  const url = completionURL(provider);
  const secretName = provider.api_key_env || 'MODEL_API_KEY';
  const apiKey = process.env[secretName] || '';
  if (!apiKey) return json(res,503,{error:`模型服务未配置密钥，请设置 ${secretName}`});
  const timeout = Math.min(180000, Math.max(1000, Number(spec.timeout_ms) || 30000));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  const params = {model: spec.model, messages:[{role:'system',content:input.sys},{role:'user',content:input.user}],stream:false};
  if (Number.isFinite(spec.temperature)) params.temperature = spec.temperature;
  if (Number.isFinite(spec.max_tokens)) params.max_tokens = spec.max_tokens;
  if (spec.thinking && ['enabled', 'disabled'].includes(spec.thinking.type)) params.thinking = {type: spec.thinking.type};
  if (typeof spec.enable_thinking === 'boolean') params.enable_thinking = spec.enable_thinking;
  if (provider.response_format_json) params.response_format = {type:'json_object'};
  const headers = {'Content-Type':'application/json'};
  if (apiKey) headers.Authorization = 'Bearer '+apiKey;
  const start=Date.now();
  try {
    const upstream = await fetch(url, {method:'POST',headers,body:JSON.stringify(params),signal:abort.signal});
    const raw = await upstream.text();
    if (!upstream.ok) return json(res,502,{error:`模型服务 HTTP ${upstream.status}`,detail:raw.slice(0,500)});
    let data;try {data=JSON.parse(raw);}catch {return json(res,502,{error:'模型服务返回的不是 JSON',detail:raw.slice(0,300)});}
    return json(res,200,{text:completionText(data),node:pid,model:spec.model,elapsed_ms:Date.now()-start,usage:data.usage || null});
  } catch(e) {
    return json(res,502,{error:e.name==='AbortError'?`模型调用超时（${timeout} ms）`:(e?.message || '模型调用失败')});
  } finally {clearTimeout(timer);}
}
// Only serve the public application files. In particular, .env and model configuration
// stay on the server even when this application is deployed behind a reverse proxy.
const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/debug', 'LoveMi_在线测试版_v1.9.html'],
  ['/debug/', 'LoveMi_在线测试版_v1.9.html'],
  ['/LoveMi_在线测试版_v1.9.html', 'LoveMi_在线测试版_v1.9.html'],
  ['/local_model_client.js', 'local_model_client.js'],
  ['/src/engine.js', 'src/engine.js'],
  ['/data/config.json', 'data/config.json'],
  ['/data/prompts.json', 'data/prompts.json']
]);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};
function requestPath(req) {
  const raw = (req.url || '/').split('?')[0];
  if (!raw.startsWith('/')) throw Object.assign(new Error('Invalid path'), {status: 400});
  let pathname;
  try { pathname = decodeURIComponent(raw); }
  catch { throw Object.assign(new Error('Invalid path encoding'), {status: 400}); }
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '.' || part === '..')) {
    throw Object.assign(new Error('Not found'), {status: 404});
  }
  return pathname;
}
function publicFile(pathname) {
  const exact = PUBLIC_FILES.get(pathname);
  if (exact) return path.join(ROOT, exact);
  if (!/^\/assets\/(?:[a-z0-9][a-z0-9_.-]*\/)*[a-z0-9][a-z0-9_.-]*\.(?:css|js|png|webp|svg|jpe?g|ico)$/i.test(pathname)) return null;
  const absolute = path.resolve(ROOT, '.' + pathname);
  const assetsRoot = path.join(ROOT, 'assets') + path.sep;
  if (!absolute.startsWith(assetsRoot)) return null;
  // Also prevent a symlink in assets from pointing at private files outside assets.
  try { if (!fs.realpathSync(absolute).startsWith(fs.realpathSync(path.join(ROOT, 'assets')) + path.sep)) return null; }
  catch { return null; }
  return absolute;
}
function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients do not send an Origin header.
  try {
    const source = new URL(origin);
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin) return false;
    const target = new URL('http://' + req.headers.host);
    if (source.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(source.hostname) && ['127.0.0.1', 'localhost'].includes(target.hostname)) return true;
    const host = target.host;
    // HTTPS is commonly terminated by the deployment platform before reaching Node.
    // The hostname and port must still match this request; no arbitrary CORS origin is allowed.
    return source.host === host;
  } catch { return false; }
}
async function requestHandler(req,res) {
  try {
    const pathname = requestPath(req);
    if (req.method==='GET' && pathname==='/api/status') {
      const c=modelConfig();return json(res,200,{ok:true,version:'v1.9+P1B-v1.11',nodes:Object.fromEntries(Object.entries(c.nodes||{}).map(([p,x])=>[p,x.model])),api_base:process.env.MODEL_API_BASE||c.provider?.api_base,key_configured:Boolean(process.env[c.provider?.api_key_env||'MODEL_API_KEY'])});
    }
    if (req.method==='POST' && pathname==='/api/model') {
      if (!allowedOrigin(req)) return json(res,403,{error:'模型接口只允许同源页面或本地页面访问'});
      return await handleModel(req,res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = publicFile(pathname);
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const body = fs.readFileSync(file);
        res.writeHead(200, {'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()], 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
    }
    return json(res,404,{error:'Not found'});
  } catch(e) {if(!res.headersSent)json(res,e.status||500,{error:e.message||'服务器内部错误'});}
}
const server = http.createServer(requestHandler);
if (require.main === module) {
  if (!Number.isInteger(PORT) || PORT<1 || PORT>65535) throw new Error('PORT 无效');
  server.listen(PORT, HOST, () => console.log(`LoveMi v1.9 + P1B v1.11: http://${HOST}:${PORT}`));
}
module.exports={server,requestHandler,readJson,completionURL,completionText,allowedOrigin,requestPath,publicFile};
