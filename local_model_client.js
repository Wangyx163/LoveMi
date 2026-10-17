/* Local node model adapter: never sends API keys to the browser. */
window.lovemiLocalModel = async function ({id,pid,sys,user,tier},signal) {
  let response;
  try {
    response = await fetch('/api/model', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id,pid,sys,user,tier}),
      signal
    });
  } catch(e) {
    const error=new Error('无法连接本地服务：'+(e.message||e));error.code='unavailable';throw error;
  }
  const result=await response.json().catch(()=>({error:'服务器返回格式异常'}));
  if (!response.ok) {
    console.warn('LoveMi 模型节点失败',pid,result.error,result.detail || '');
    const error=new Error(result.error || '模型调用失败');
    error.code=response.status===400?'configuration_error':'unavailable';
    throw error;
  }
  return result.text || '';
};
