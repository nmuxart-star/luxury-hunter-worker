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

// Vestiaire: la extensión devuelve en "body" el JSON de su buscador
// ({model, items...}) o, si Vestiaire pide verificación, status 403.
export async function macVestiaireSearch(query,token){
  if(!token)throw new Error('Puente de Mac no configurado');
  const result=await call('/vestiaire',{token,body:{query},timeoutMs:90_000});
  if(Number(result?.status)===403)return {blocked:true,reason:String(result.body||'').slice(0,120)};
  if(Number(result?.status)!==200)throw new Error(`Vestiaire desde el Mac: ${String(result?.body||'sin respuesta').slice(0,160)}`);
  let payload;
  try{payload=JSON.parse(result.body);}catch{throw new Error('Vestiaire desde el Mac: respuesta no válida');}
  return payload;
}
