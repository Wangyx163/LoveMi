'use strict';
// Integration coverage uses an in-process model stub and never calls a paid model API.
const {spawn}=require('node:child_process');
const http=require('node:http');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const BASE=path.join(__dirname,'..');
const modelConfig=JSON.parse(fs.readFileSync(path.join(BASE,'config/models.json'),'utf8'));
let testPort;
let lastRequest=null;
const fake=http.createServer((req,res)=>{
 if(req.url!=='/v1/chat/completions'){res.writeHead(404).end();return;}
 let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  lastRequest=JSON.parse(body);
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({answer_status:'answered',ack:'嗯，安全感确实挺重要的。'})}}],usage:{prompt_tokens:100,completion_tokens:15}}));
 });
});
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
function request(target,options={}){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:testPort,path:target,method:options.method||'GET',headers:options.headers||{}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));
  });
  req.on('error',reject);req.end(options.body);
 });
}
async function availablePort(){
 const probe=http.createServer();
 await new Promise(r=>probe.listen(0,'127.0.0.1',r));
 const port=probe.address().port;
 await new Promise(r=>probe.close(r));
 return port;
}
(async()=>{
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));
 testPort=await availablePort();
 const upstreamPort=fake.address().port;
 const processEnv={...process.env,HOST:'127.0.0.1',PORT:String(testPort),MODEL_API_BASE:'http://127.0.0.1:'+upstreamPort+'/v1'};
 const gateway=spawn(process.execPath,[path.join(BASE,'server.js')],{cwd:BASE,env:processEnv,stdio:['ignore','pipe','pipe']});
 let startupError='';gateway.stderr.on('data',chunk=>startupError+=chunk);
 try{
  let ready=false;
  for(let i=0;i<35;i++){
   await delay(90);
   try{const response=await request('/api/status');if(response.status===200){ready=true;break;}}catch{}
  }
  assert(ready,'gateway did not start: '+startupError);
  const status=await request('/api/status');assert.equal(JSON.parse(status.text).ok,true);assert(!status.text.includes('api_key'));
  const root=await request('/');assert.equal(root.status,200);assert(root.text.includes('LoveMi'));
  const index=await request('/index.html');assert.equal(index.text,root.text);
  const debug=await request('/debug');assert.equal(debug.status,200);
  const servedPromptDefaults=debug.text.match(/^const DEFAULT_PROMPTS = (.*);$/m);
  assert(servedPromptDefaults,'debug page must include prompt defaults');
  assert.deepEqual(JSON.parse(servedPromptDefaults[1]),JSON.parse(fs.readFileSync(path.join(BASE,'data/prompts.json'),'utf8')),'debug prompt defaults must match runtime prompts');
  assert.notEqual(root.text,debug.text,'home page must be the user interface, separate from the debug page');
  const oldDebug=await request('/'+encodeURIComponent('LoveMi_在线测试版_v1.9.html'));assert.equal(oldDebug.text,debug.text);
  for(const [target,contentType] of [
   ['/local_model_client.js','application/javascript'],
   ['/src/engine.js','application/javascript'],
   ['/data/config.json','application/json'],
   ['/data/prompts.json','application/json'],
   ['/assets/app.js','application/javascript'],
   ['/assets/app.css','text/css']
  ]){
   const response=await request(target);assert.equal(response.status,200,target);assert(response.headers['content-type'].startsWith(contentType),target);assert.equal(response.headers['x-content-type-options'],'nosniff');
  }
  const head=await request('/index.html',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.text,'');
  for(const target of ['/.env','/server.js','/package.json','/config/models.json','/data/demo_scripts.json','/src/other.js','/assets/private.txt','/assets/.env','/assets/../.env','/assets/%2e%2e/.env','/assets/%2E%2E%2F.env','/assets/%5c..%5c.env','/assets/%252e%252e/.env']){
   const response=await request(target);assert.equal(response.status,404,target);
  }
  const malformed=await request('/assets/%xx.png');assert.equal(malformed.status,400);
  const modelInput=JSON.stringify({pid:'P1B',sys:'你是 LoveMi',user:'安全感',tier:'fast'});
  const model=await request('/api/model',{
   method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:'+testPort},body:modelInput});
  const data=JSON.parse(model.text);assert.equal(model.status,200,model.text);assert(data.text.includes('安全感确实挺重要'));assert.equal(lastRequest.messages[1].content,'安全感');assert.equal(lastRequest.stream,false);
  assert.equal(lastRequest.model,modelConfig.nodes.P1B.model);
  assert.equal(lastRequest.enable_thinking,false);
  assert.equal(lastRequest.thinking,undefined);
  for(const pid of ['P3','P5','P6','P7','PE','PC']) {
   const response=await request('/api/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pid,sys:'test',user:'test'})});
   assert.equal(response.status,200);
   assert.equal(lastRequest.model,modelConfig.nodes[pid].model);
   assert.equal(lastRequest.enable_thinking,['P6','P7'].includes(pid));
  }
  // Emulate a deployment platform terminating HTTPS before forwarding to Node.
  const deployed=await request('/api/model',{method:'POST',headers:{Host:'lovemi.example',Origin:'https://lovemi.example','Content-Type':'application/json'},body:modelInput});assert.equal(deployed.status,200,deployed.text);
  const deployedPort=await request('/api/model',{method:'POST',headers:{Host:'lovemi.example:8080',Origin:'https://lovemi.example:8080','Content-Type':'application/json'},body:modelInput});assert.equal(deployedPort.status,200,deployedPort.text);
  const localhost=await request('/api/model',{method:'POST',headers:{Origin:'http://localhost:8768','Content-Type':'application/json'},body:modelInput});assert.equal(localhost.status,200);
  for(const origin of ['https://unrelated.example','https://lovemi.example.attacker.test','https://lovemi.example:444','http://localhost:8768','null','file://']){
   const denied=await request('/api/model',{method:'POST',headers:{Host:'lovemi.example',Origin:origin,'Content-Type':'application/json'},body:modelInput});assert.equal(denied.status,403,origin);
  }
  const missing=await request('/api/model',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"pid":"UNKNOWN","sys":"a","user":"b"}'});assert.equal(missing.status,400);
  for(const pid of ['P1','P6E']){
   const retired=await request('/api/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pid,sys:'test',user:'test'})});assert.equal(retired.status,400);
  }
  const invalid=await request('/api/model',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"pid":'});assert.equal(invalid.status,400);
  const oversized=await request('/api/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pid:'P1B',sys:'你'.repeat(90000),user:'test'})});assert.equal(oversized.status,413);
  console.log('✓ 网关集成通过：首页与调试入口、前端静态资源、路径保护、六节点模型代理、部署同源校验');
 }finally{
  gateway.kill();
  await new Promise(r=>gateway.exitCode!==null||gateway.signalCode!==null?r():gateway.once('exit',r));
  fake.closeAllConnections?.();await new Promise(r=>fake.close(r));
 }
})().catch(e=>{console.error(e);process.exitCode=1;fake.closeAllConnections?.();fake.close();});
