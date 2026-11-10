const BASE='http://127.0.0.1:8210';

async function call(path,{token,body,timeoutMs}){
  const response=await fetch(BASE+path,{method:body?'POST':'GET',
    headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeoutMs)});
  const json=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`Mac One Map HTTP ${response.status}: ${json.error||'error'}`);
  return json;
}

export async function macOneMapReady(token){
  if(!token)return false;
  try{
    const health=await call('/health',{token,timeoutMs:2500});
    return health.extensionReady===true;
  }catch{return false;}
}

export async function macOneMapSnapshot(url,token){
  if(!token)throw new Error('Puente de Mac no configurado');
  const result=await call('/snapshot',{token,body:{url},timeoutMs:80_000});
  if(!result||typeof result.html!=='string'||typeof result.body!=='string'){
    throw new Error('Respuesta del Mac inválida');
  }
  return result;
}

// Búsqueda de Xianyu en el Chrome del Mac. Devuelve la respuesta del buscador
// de Goofish tal cual la vio la página (texto JSON) y lo que hizo la extensión.
export async function macXianyuSearch(query,{minCny=null,maxCny=null}={},token){
  if(!token)throw new Error('Puente de Mac no configurado');
  const result=await call('/xianyu',{token,body:{query,minCny,maxCny},timeoutMs:150_000});
  if(!result||typeof result.body!=='string')throw new Error('Respuesta del Mac inválida');
  let payload={};
  try{payload=JSON.parse(result.body);}catch{payload={error:String(result.body).slice(0,200)};}
  return {status:result.status,finalUrl:result.finalUrl||'',title:result.title||'',...payload};
}
