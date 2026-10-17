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
function readJson(req) {
  return new Promise((resolve,reject) => {
    let size = 0, raw = '';
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('请求体过大'),{status:413})); req.destroy(); return; } raw += chunk.toString('utf8'); });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('JSON 格式错误'), {status:400})); } });
    req.on('error', reject);
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
// Only serve required browser assets; never expose .env, config/models.json, or server source.
const PAGE = path.join(ROOT, 'LoveMi_在线测试版_v1.9.html');
const CLIENT = path.join(ROOT, 'local_model_client.js');
const server = http.createServer(async (req,res) => {
  try {
    const pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
    if (req.method==='GET' && pathname==='/api/status') {
      const c=modelConfig();return json(res,200,{ok:true,version:'v1.9+P1B-v1.11',nodes:Object.fromEntries(Object.entries(c.nodes||{}).map(([p,x])=>[p,x.model])),api_base:c.provider?.api_base});
    }
    if (req.method==='POST' && pathname==='/api/model') {
      const origin=req.headers.origin;
      if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)) return json(res,403,{error:'本地模型接口只允许本地页面访问'});
      return await handleModel(req,res);
    }
    if (req.method === 'GET' && ['/', '/index.html','/LoveMi_在线测试版_v1.9.html','/local_model_client.js'].includes(pathname)) {
      const js=pathname==='/local_model_client.js';
      res.writeHead(200,{'Content-Type':js?'application/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      return res.end(fs.readFileSync(js?CLIENT:PAGE));
    }
    return json(res,404,{error:'Not found'});
  } catch(e) {if(!res.headersSent)json(res,e.status||500,{error:e.message||'服务器内部错误'});}
});
if (require.main === module) {
  if (!Number.isInteger(PORT) || PORT<1 || PORT>65535) throw new Error('PORT 无效');
  server.listen(PORT, HOST, () => console.log(`LoveMi v1.9 + P1B v1.11: http://${HOST}:${PORT}`));
}
module.exports={server,completionURL,completionText};
