// Diagnóstico de Xianyu: lanza UNA búsqueda en el conector (igual que hace
// Luxury Hunter), espera a que termine y muestra el estado, los resultados y
// el log del buscador. No usa IA.
// Uso: node scripts/xianyu-diagnose.mjs "<palabra clave>" [carpeta de logs]
import fs from 'node:fs';
import path from 'node:path';

const base=String(process.env.XIANYU_BASE_URL||'http://127.0.0.1:8000').replace(/\/$/,'');
const keyword=process.argv[2]||'celine luggage';
const logsDir=process.argv[3]||'.xianyu/logs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function call(method,url,body){
  const r=await fetch(base+url,{
    method,
    headers:{'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(20000)
  });
  const text=await r.text();
  let data;
  try{data=JSON.parse(text);}catch{data=text;}
  return {status:r.status,data};
}

const taskName=`LH diagnose ${Date.now()}`;
console.log(`Conector: ${base}`);
console.log('Health:',JSON.stringify((await call('GET','/health')).data));

const created=await call('POST','/api/tasks/',{
  task_name:taskName,
  enabled:true,
  keyword,
  description:'Luxury Hunter diagnostic search.',
  analyze_images:false,
  max_pages:1,
  personal_only:false,
  min_price:null,
  max_price:null,
  cron:null,
  account_state_file:null,
  account_strategy:'auto',
  free_shipping:false,
  new_publish_option:null,
  region:null,
  decision_mode:'keyword',
  keyword_rules:[keyword.split(/\s+/)[0]]
});
console.log('Crear tarea:',created.status,JSON.stringify(created.data).slice(0,500));
const id=created.data?.task?.id;
if(!id){
  console.log('El conector no devolvió ID de tarea. Fin.');
  process.exit(0);
}
const started=await call('POST',`/api/tasks/start/${id}`);
console.log('Arrancar tarea:',started.status,JSON.stringify(started.data).slice(0,300));

const t0=Date.now();
let seenRunning=false;
while(Date.now()-t0<240000){
  await sleep(3000);
  const t=await call('GET',`/api/tasks/${id}`);
  const running=!!t.data?.is_running;
  if(running&&!seenRunning)console.log(`En marcha tras ${Math.round((Date.now()-t0)/1000)} s`);
  if(running)seenRunning=true;
  if(seenRunning&&!running)break;
  if(!seenRunning&&Date.now()-t0>20000){
    console.log('La tarea nunca llegó a estar en marcha.');
    break;
  }
}
console.log(`Duración: ${Math.round((Date.now()-t0)/1000)} s`);

const filename=`${keyword.replaceAll(' ','_')}_full_data.jsonl`;
const results=await call('GET',`/api/results/${encodeURIComponent(filename)}?page=1&limit=5&include_hidden=true&sort_by=crawl_time&sort_order=desc`);
console.log('Resultados:',results.status,JSON.stringify(results.data).slice(0,1500));
const files=await call('GET','/api/results/files');
console.log('Ficheros de resultados:',files.status,JSON.stringify(files.data).slice(0,500));

const logs=fs.existsSync(logsDir)
  ? fs.readdirSync(logsDir).filter(f=>f.endsWith('.log')).map(f=>path.join(logsDir,f)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)
  : [];
if(!logs.length)console.log(`No hay logs en ${logsDir}`);
for(const f of logs.slice(0,2)){
  console.log(`\n===== ${f} =====`);
  console.log(fs.readFileSync(f,'utf8').split('\n').slice(-150).join('\n'));
}
await call('DELETE',`/api/tasks/${id}`).catch(()=>{});
