import http from 'node:http';
import {randomUUID} from 'node:crypto';

const MAX_BODY=2_000_000;
const MAX_PENDING=30;
const DEFAULT_TIMEOUT_MS=75_000;

function allowedOneMapUrl(value){
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&url.hostname==='www.fromjapan.co.jp'&&
      (/^\/japan\/en\/yahoo-auctions\/search\//.test(url.pathname)||
       /^\/japan\/en\/auction\/yahoo\/input\/[a-z0-9]+\/?$/i.test(url.pathname));
  }catch{return false;}
}

// Búsqueda de Vestiaire desde el Chrome del Mac: solo un texto corto; la
// extensión abre la portada de Vestiaire y consulta su buscador desde allí.
export const VESTIAIRE_HOME='https://es.vestiairecollective.com/';
export function allowedVestiaireQuery(value){
  const q=String(value??'');
  return q.length>=3&&q.length<=80&&!/[\r\n<>]/.test(q);
}

// Búsqueda de Xianyu desde el Chrome del Mac (regla de Nil, 10-11-2026): el
// servidor de la nube está marcado por Xianyu; el Chrome de Nil tiene su sesión
// y su conexión de casa. Solo se pasa una palabra de búsqueda y un rango de precio.
export function allowedXianyuQuery(value){
  const q=String(value??'').trim();
  return q.length>=1&&q.length<=80&&!/[\r\n<>]/.test(q);
}
export const xianyuSearchUrl=q=>`https://www.goofish.com/search?q=${encodeURIComponent(String(q).trim())}`;
const cnyOrNull=v=>{const n=Number(v);return Number.isFinite(n)&&n>0&&n<1e7?Math.round(n):null;};
const XIANYU_TIMEOUT_MS=130_000;

function send(res,status,body){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store'});
  res.end(JSON.stringify(body));
}

async function readJson(req){
  let size=0;
  const chunks=[];
  for await(const chunk of req){
    size+=chunk.length;
    if(size>MAX_BODY)throw new Error('Respuesta demasiado grande');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createOneMapMacBridge({token,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  if(!token||String(token).length<32)throw new Error('ONEMAP_MAC_BRIDGE_TOKEN debe tener al menos 32 caracteres');
  const jobs=new Map();
  let extensionLastSeen=0;
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.authorization!==`Bearer ${token}`)return send(res,401,{error:'unauthorized'});
      const path=new URL(req.url,'http://127.0.0.1').pathname;
      if(req.method==='POST'&&path==='/heartbeat'){
        extensionLastSeen=Date.now();
        return send(res,200,{ok:true});
      }
      if(req.method==='GET'&&path==='/health'){
        return send(res,200,{ok:true,extensionReady:Date.now()-extensionLastSeen<75_000,
          pending:jobs.size});
      }
      if(req.method==='GET'&&path==='/next'){
        extensionLastSeen=Date.now();
        const job=[...jobs.values()].find(x=>!x.dispatched);
        if(!job)return send(res,200,{job:null});
        job.dispatched=true;
        return send(res,200,{job:{id:job.id,url:job.url,...(job.kind?{kind:job.kind,query:job.query}:{}),...(job.kind==='xianyu'?{minCny:job.minCny,maxCny:job.maxCny}:{})}});
      }
      if(req.method==='POST'&&(path==='/snapshot'||path==='/vestiaire'||path==='/xianyu')){
        const body=await readJson(req);
        const vestiaire=path==='/vestiaire',xianyu=path==='/xianyu';
        if(xianyu?!allowedXianyuQuery(body?.query):vestiaire?!allowedVestiaireQuery(body?.query):!allowedOneMapUrl(body?.url))return send(res,400,{error:xianyu||vestiaire?'Búsqueda no permitida':'URL no permitida'});
        if(jobs.size>=MAX_PENDING)return send(res,503,{error:'cola llena'});
        const id=randomUUID();
        const job=xianyu?{id,url:xianyuSearchUrl(body.query),kind:'xianyu',query:String(body.query).trim(),minCny:cnyOrNull(body.minCny),maxCny:cnyOrNull(body.maxCny),dispatched:false}
          :vestiaire?{id,url:VESTIAIRE_HOME,kind:'vestiaire',query:String(body.query),dispatched:false}:{id,url:body.url,dispatched:false};
        jobs.set(id,job);
        const timer=setTimeout(()=>{
          if(jobs.delete(id))send(res,504,{error:'El Chrome del Mac no respondió a tiempo'});
        },xianyu?Math.max(timeoutMs,XIANYU_TIMEOUT_MS):timeoutMs);
        job.finish=(status,payload)=>{
          clearTimeout(timer);
          if(jobs.delete(id))send(res,status,payload);
        };
        req.on('close',()=>{
          // La conexión puede cerrarse después de recibir el cuerpo sin cancelar la respuesta.
          if(res.destroyed){clearTimeout(timer);jobs.delete(id);}
        });
        return;
      }
      const match=path.match(/^\/result\/([a-f0-9-]{36})$/i);
      if(req.method==='POST'&&match){
        const job=jobs.get(match[1]);
        if(!job)return send(res,404,{error:'tarea caducada'});
        const body=await readJson(req);
        if(body?.url!==job.url||typeof body?.html!=='string'||
          typeof body?.body!=='string'||typeof body?.title!=='string'){
          job.finish(502,{error:'respuesta local inválida'});
          return send(res,400,{error:'respuesta inválida'});
        }
        job.finish(200,{status:Number(body.status)||200,finalUrl:body.finalUrl||job.url,
          html:body.html,body:body.body,title:body.title});
        return send(res,200,{ok:true});
      }
      return send(res,404,{error:'not found'});
    }catch(e){
      if(!res.headersSent)send(res,400,{error:e.message});
    }
  });
  return server;
}

if(process.argv[1]&&new URL(`file://${process.argv[1]}`).href===import.meta.url){
  const server=createOneMapMacBridge({token:process.env.ONEMAP_MAC_BRIDGE_TOKEN});
  const port=Number(process.env.ONEMAP_MAC_BRIDGE_PORT)||8210;
  server.listen(port,'127.0.0.1',()=>console.log(`One Map Mac bridge: 127.0.0.1:${port}`));
}
