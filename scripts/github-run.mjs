import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base='http://127.0.0.1:8200';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(method,url,body){
  const r=await fetch(base+url,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const txt=await r.text(); let data={}; try{data=txt?JSON.parse(txt):{}}catch{data={raw:txt}}
  if(!r.ok) throw new Error(`${method} ${url}: ${r.status} ${data.error||txt}`);
  return data;
}
function due(task,now=new Date()){
  if(!task.enabled) return false;
  if(task.interval_minutes){
    if(!task.last_run_at) return true;
    return now.getTime()-new Date(task.last_run_at).getTime() >= Number(task.interval_minutes)*60000-120000;
  }
  // GitHub Actions v1.5 is optimized for interval tasks. Cron tasks are left to the local scheduler.
  return false;
}
async function waitServer(){
  for(let i=0;i<60;i++){
    try{await api('GET','/api/status');return}catch{}
    await sleep(1000);
  }
  throw new Error('Luxury Hunter no arrancó en 60s');
}
async function waitRun(id){
  for(let i=0;i<360;i++){
    const {run}=await api('GET',`/api/task-runs/${id}`);
    if(run.status==='finished') return run;
    if(run.status==='error') throw new Error(run.error||`Run ${id} failed`);
    await sleep(5000);
  }
  throw new Error(`Timeout esperando run ${id}`);
}
const cfgPath=path.join(root,'cloud','config.json');
if(!fs.existsSync(cfgPath)) throw new Error('Falta cloud/config.json. Ejecuta npm run cloud:export en tu Mac y súbelo al repo.');
const cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
const globalEmailTo=String(cfg.global_email?.to||'').trim();
const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{
  ...process.env,
  DISABLE_SCHEDULER:'1',
  PORT:'8200',
  ...(globalEmailTo&&!process.env.GLOBAL_EMAIL_TO?{GLOBAL_EMAIL_TO:globalEmailTo}:{})
},stdio:'inherit'});
const envInt=(name,fallback,min,max)=>{
  const n=Number(process.env[name]);
  return Number.isFinite(n)?Math.max(min,Math.min(max,Math.trunc(n))):fallback;
};
// Varias tareas a la vez: un ciclo completo pasa de ~45 min a ~15-20 min.
const TASK_CONCURRENCY=envInt('TASK_CONCURRENCY',3,1,6);
// Modo bucle: repite ciclos durante LOOP_MINUTES (0 = una sola pasada).
const LOOP_MINUTES=envInt('LOOP_MINUTES',0,0,340);
const CYCLE_MIN_MINUTES=envInt('CYCLE_MIN_MINUTES',20,5,180);
const workerStartedAt=Date.now();
async function runPool(items,limit,fn){
  let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){
      const item=items[next++];
      await fn(item);
    }
  }));
}
let code=0;
try{
  await waitServer();
  console.log('Luxury Hunter cloud worker ready.');
  if(cfg.economics) await api('PUT','/api/economics',cfg.economics);
  const xianyuSession=String(process.env.XIANYU_SESSION_STATUS||'').trim();
  if(['expired','missing','error'].includes(xianyuSession)){
    await api('POST','/api/health/report',{
      key:'xianyu-login',
      message:`La sesión de Xianyu no es válida (${xianyuSession}). China no se está buscando. `+
        'En tu Mac ejecuta: cd ~/luxury-hunter && npm run xianyu:login, y sube cloud/xianyu-state.enc.'
    }).catch(e=>console.error('Health report failed:',e.message));
  }else if(xianyuSession==='risk_control'){
    await api('POST','/api/health/report',{
      key:'xianyu-risk',
      message:'La sesión de Xianyu es válida, pero Goofish ha pedido una verificación anti-bot desde el servidor de GitHub. Puede que Xianyu no devuelva resultados en la nube.'
    }).catch(e=>console.error('Health report failed:',e.message));
  }else if(xianyuSession==='ok'){
    await api('POST','/api/health/report',{key:'xianyu-login',clear:true}).catch(()=>{});
    await api('POST','/api/health/report',{key:'xianyu-risk',clear:true}).catch(()=>{});
  }
  const existing=(await api('GET','/api/tasks')).tasks||[];
  for(const t of cfg.tasks||[]){
    const old=existing.find(x=>x.task_name===t.task_name);
    if(old) await api('PATCH',`/api/tasks/${old.id}`,t);
    else await api('POST','/api/tasks',t);
  }
  const configuredNames=new Set((cfg.tasks||[]).map(t=>t.task_name));
  for(const old of existing){
    if(!configuredNames.has(old.task_name) && old.enabled){
      await api('PATCH',`/api/tasks/${old.id}`,{...old,enabled:false});
      console.log(`Disabled stale cloud task: ${old.task_name}`);
    }
  }
  const forceManual=process.env.GITHUB_EVENT_NAME==='workflow_dispatch';
  const globalEmail=cfg.global_email||{};
  let cycle=0;
  while(true){
    cycle++;
    const cycleStartedAt=Date.now();
    const tasks=(await api('GET','/api/tasks')).tasks||[];
    // En modo bucle o lanzamiento manual se ejecutan todas las tareas activas
    // en cada ciclo: lo ya analizado se salta, así que repetir es barato.
    const runAll=forceManual||LOOP_MINUTES>0;
    const runnable=runAll
      ? tasks.filter(t=>t.enabled)
      : tasks.filter(t=>due(t));
    console.log(`\n##### CICLO ${cycle}: ${runnable.length}/${tasks.length} tareas, concurrencia ${TASK_CONCURRENCY} #####`);
    const taskResults=[];
    await runPool(runnable,TASK_CONCURRENCY,async task=>{
      console.log(`\n=== RUN ${task.task_name} ===`);
      try{
        const q=await api('POST',`/api/tasks/${task.id}/run`,{});
        const run=await waitRun(q.runId);
        taskResults.push({task_id:task.id,task_name:task.task_name,status:run.status,run_id:q.runId});
        console.log(`DONE ${task.task_name}: ${run.status}`);
      }catch(e){
        taskResults.push({task_id:task.id,task_name:task.task_name,status:'error',error:e?.message||String(e)});
        console.error(`FAILED ${task.task_name}:`,e?.message||e);
      }
    });

    try{
      const digest=await api('POST','/api/email/global-digest',{
        to:globalEmail.to||null,
        force:forceManual&&cycle===1,
        config:globalEmail
      });
      if(digest.sent){
        console.log(`Global 3h digest sent: ${digest.subject}; opportunities=${digest.opportunities??0}`);
      }else{
        console.log(`Global digest not sent: ${digest.reason||'unknown'}${digest.minutes_until_due!=null?`; due in ~${digest.minutes_until_due} min`:''}`);
      }
    }catch(e){
      code=1;
      console.error('Global digest failed:',e?.stack||e);
    }

    if(taskResults.some(x=>x.status==='error')){
      console.warn('One or more tasks failed, but the worker continues so state and the 3h digest cadence are preserved.');
    }

    const cycleMinutes=(Date.now()-cycleStartedAt)/60000;
    console.log(`Ciclo ${cycle} completado en ${cycleMinutes.toFixed(1)} min.`);
    if(!LOOP_MINUTES)break;
    const waitMs=Math.max(0,CYCLE_MIN_MINUTES*60000-(Date.now()-cycleStartedAt));
    const elapsedMin=(Date.now()-workerStartedAt+waitMs)/60000;
    // No empezar un ciclo que no daría tiempo a terminar dentro del presupuesto.
    if(elapsedMin+Math.max(cycleMinutes,CYCLE_MIN_MINUTES)>LOOP_MINUTES){
      console.log(`Presupuesto de bucle (${LOOP_MINUTES} min) agotado tras ${cycle} ciclos.`);
      break;
    }
    if(waitMs)await sleep(waitMs);
  }
}catch(e){
  code=1; console.error(e?.stack||e);
}finally{
  if(child.exitCode===null && child.signalCode===null){
    child.kill('SIGTERM');

    await Promise.race([
      new Promise(resolve=>child.once('exit',resolve)),
      sleep(5000)
    ]);
  }

  if(child.exitCode===null && child.signalCode===null){
    console.log('Luxury Hunter server did not stop after SIGTERM; forcing shutdown.');
    child.kill('SIGKILL');

    await Promise.race([
      new Promise(resolve=>child.once('exit',resolve)),
      sleep(1000)
    ]);
  }

  console.log('Luxury Hunter cloud worker finished. Continuing GitHub workflow.');
  process.exit(code);
}
