import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base='http://127.0.0.1:8200';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(method,url,body){
  let r;
  // Reintenta errores de red (servidor ocupado un momento); no los HTTP.
  for(let attempt=1;;attempt++){
    try{
      r=await fetch(base+url,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      break;
    }catch(e){
      if(attempt>=8)throw e;
      await sleep(3000*attempt);
    }
  }
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
// Reparto de los modelos a lo largo del día: cada ejecución dura como mucho
// RUN_BUDGET_MINUTES (más ~6 min de preparación de GitHub) y empieza por los
// modelos que llevan más tiempo sin revisarse. Solo arranca un modelo si,
// según lo que tardó en sus últimas pasadas, le da tiempo a terminar; los
// demás pasan a la siguiente ejecución. 0 = todas las tareas en cada pasada.
const RUN_BUDGET_MINUTES=envInt('RUN_BUDGET_MINUTES',38,0,340);
const workerStartedAt=Date.now();
const elapsedMinutes=()=>(Date.now()-workerStartedAt)/60000;
// Minutos que tarda cada modelo: media de sus 3 últimas pasadas (25 si no hay).
function taskMinutesEstimate(){
  const byTask=new Map();
  try{
    const db=new DatabaseSync(path.join(root,'data','luxury-hunter.sqlite3'),{readOnly:true});
    const rows=db.prepare(`SELECT task_id,(julianday(finished_at)-julianday(started_at))*1440 AS m
      FROM task_runs WHERE status='finished' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 500`).all();
    db.close();
    for(const r of rows){
      const list=byTask.get(r.task_id)||[];
      if(list.length<3&&r.m>0&&r.m<240){list.push(r.m);byTask.set(r.task_id,list);}
    }
  }catch(e){console.warn('Sin historial de duración de tareas:',e.message);}
  return id=>{const l=byTask.get(id);return l?.length?l.reduce((a,b)=>a+b,0)/l.length:25;};
}
// Como runPool, pero cada hueco solo empieza una tarea si canStart lo permite.
async function runPool(items,limit,fn,canStart=()=>true){
  let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){
      if(!canStart(items[next]))return;
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
  // En modo directo (por defecto) solo se avisa si la búsqueda falla de
  // verdad (lo hace server.mjs); una sesión caducada que sigue buscando
  // bien no es un problema para Nil.
  const xianyuDirect=String(process.env.XIANYU_MODE||'direct').toLowerCase()!=='connector';
  if(xianyuDirect){
    console.log(`Xianyu session status: ${xianyuSession||'desconocido'} (modo directo)`);
  }else if(['expired','missing','error'].includes(xianyuSession)){
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
    // Primero los modelos que llevan más tiempo sin revisarse.
    runnable.sort((a,b)=>(Date.parse(a.last_run_at||'')||0)-(Date.parse(b.last_run_at||'')||0));
    const estimate=taskMinutesEstimate();
    let started=0;
    const canStart=task=>{
      if(!RUN_BUDGET_MINUTES||started===0)return true;
      return elapsedMinutes()+estimate(task.id)<=RUN_BUDGET_MINUTES;
    };
    console.log(`\n##### CICLO ${cycle}: ${runnable.length}/${tasks.length} tareas, concurrencia ${TASK_CONCURRENCY}${RUN_BUDGET_MINUTES?`, máximo ${RUN_BUDGET_MINUTES} min`:''} #####`);
    const taskResults=[];
    await runPool(runnable,TASK_CONCURRENCY,async task=>{
      started++;
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
    },canStart);
    if(RUN_BUDGET_MINUTES){
      const done=new Set(taskResults.map(x=>x.task_id));
      const waiting=runnable.filter(t=>!done.has(t.id)).map(t=>t.task_name);
      console.log(`Reparto: ${done.size} modelos en esta ejecución (${elapsedMinutes().toFixed(1)} min); pasan a la siguiente: ${waiting.length?waiting.join(', '):'ninguno'}.`);
    }

    try{
      const digest=await api('POST','/api/email/global-digest',{
        to:globalEmail.to||null,
        // El informe diario sale a su hora; una ejecución manual no lo fuerza
        // salvo FORCE_DIGEST=1.
        force:process.env.FORCE_DIGEST==='1'&&cycle===1,
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
    if(!LOOP_MINUTES||RUN_BUDGET_MINUTES)break;
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
