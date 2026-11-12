import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {shouldRunAllTasks,isDue as due,nextDueTask,rankLaunches,launchSpacingMs} from './github-run-schedule.mjs';

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
  ...(globalEmailTo&&!process.env.GLOBAL_EMAIL_TO?{GLOBAL_EMAIL_TO:globalEmailTo}:{}),
  // Hoja de oportunidades: el ID va en la configuración cifrada, no en los logs.
  ...(cfg.opportunities_sheet_id&&!process.env.OPPORTUNITIES_SHEET_ID?{OPPORTUNITIES_SHEET_ID:String(cfg.opportunities_sheet_id)}:{})
},stdio:'inherit'});
const envInt=(name,fallback,min,max)=>{
  const n=Number(process.env[name]);
  return Number.isFinite(n)?Math.max(min,Math.min(max,Math.trunc(n))):fallback;
};
// Varias tareas a la vez: un ciclo completo pasa de ~45 min a ~15-20 min.
const TASK_CONCURRENCY=envInt('TASK_CONCURRENCY',4,1,6);
// Modo bucle: repite ciclos durante LOOP_MINUTES (0 = una sola pasada).
const LOOP_MINUTES=envInt('LOOP_MINUTES',0,0,340);
const CYCLE_MIN_MINUTES=envInt('CYCLE_MIN_MINUTES',20,5,180);
// Reparto de los modelos a lo largo del día: cada ejecución dura como mucho
// RUN_BUDGET_MINUTES (más ~6 min de preparación de GitHub) y empieza por los
// modelos que llevan más tiempo sin revisarse. Solo arranca un modelo si,
// según lo que tardó en sus últimas pasadas, le da tiempo a terminar; los
// demás pasan a la siguiente ejecución. 0 = todas las tareas en cada pasada.
const RUN_BUDGET_MINUTES=envInt('RUN_BUDGET_MINUTES',38,0,340);
// Duración mínima de una ejecución: si las tareas acaban en segundos (solo
// Xianyu), la ejecución sigue en ciclos hasta cumplirla en vez de terminar y
// encadenar otra al instante. Antes llegaban a 10-16 ejecuciones por hora,
// cada una con su propio Chromium visitando la cuenta de Xianyu. 0 = apagado.
const RUN_MIN_MINUTES=envInt('RUN_MIN_MINUTES',0,0,300);
// Si al arrancar todavía no toca ningún modelo, la ejecución espera al
// siguiente (como mucho IDLE_WAIT_MAX_MINUTES) en vez de terminar vacía:
// una ejecución vacía no encadena la siguiente y el bot se quedaba parado
// hasta el cron de GitHub, que llega con horas de retraso.
const IDLE_WAIT_MAX_MINUTES=envInt('IDLE_WAIT_MAX_MINUTES',90,0,240);
// 0 = sin máximo de relojes por ejecución (solo manda el tiempo).
// CARRIL RÁPIDO (regla de Nil, 07-11-2026): los modelos que más rotan se
// buscan solo en Xianyu y Mercari (lo más nuevo primero) en cada ejecución,
// como mucho cada FAST_LANE_MINUTES (lo decide el servidor), para llegar en
// minutos a los anuncios recién subidos. No mueve su revisión completa.
const FAST_TASKS=String(process.env.FAST_TASKS||'').split(',').map(x=>x.trim()).filter(Boolean);
const ACTIVE_SOURCES=String(process.env.ACTIVE_SOURCES||'xianyu,buyee').split(',').map(x=>x.trim()).filter(Boolean);
const FAST_LABEL=ACTIVE_SOURCES.includes('buyee')?'Xianyu + Mercari':'Xianyu';
const workerStartedAt=Date.now();
// El presupuesto de RUN_BUDGET_MINUTES empieza a contar tras esa espera.
let budgetStartedAt=workerStartedAt;
const elapsedMinutes=()=>(Date.now()-budgetStartedAt)/60000;
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
// Cada hueco coge la siguiente tarea, en orden de prioridad, que aún dé
// tiempo a terminar (canStart); si la primera no cabe, prueba las siguientes
// en vez de quedarse parado.
async function runPool(items,limit,fn,canStart=()=>true){
  const queue=[...items];
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(queue.length){
      const i=queue.findIndex(item=>canStart(item));
      if(i<0)return;
      const [item]=queue.splice(i,1);
      await fn(item);
    }
  }));
}
let code=0;
let anyTaskStarted=false;
// SALIDAS REPARTIDAS (regla de Nil, 11-11-2026): las tareas no arrancan de golpe. Cada salida que va a buscar en
// Xianyu espera su turno en una puerta única y, tras cada una, hay una pausa irregular (4,5-8,5 min y, de vez en
// cuando, un descanso largo). Así la búsqueda llega enseguida y nada se amontona esperando en la cola de Xianyu.
const LAUNCH_GAP_MIN_SEC=envInt('LAUNCH_GAP_MIN_SEC',270,1,3600);
const LAUNCH_GAP_MAX_SEC=envInt('LAUNCH_GAP_MAX_SEC',510,LAUNCH_GAP_MIN_SEC,7200);
const LAUNCH_BREAK_PROB=Math.min(1,Math.max(0,Number(process.env.LAUNCH_BREAK_PROB??0.15)));
let gateTail=Promise.resolve();
let nextLaunchAt=0;
let hardBlockedMin=0;
function launchGate(fn){
  const turn=gateTail.then(async()=>{
    // Se vuelve a mirar cada 2 s: si una tarea anterior acaba sin haber buscado, la pausa se acorta sobre la marcha.
    for(;;){
      const wait=nextLaunchAt-Date.now();
      if(wait<=0)break;
      await sleep(Math.min(wait,2000));
    }
    return fn();
  });
  gateTail=turn.catch(()=>{});
  return turn;
}
// Ritmo que se autorregula (server.mjs): con nivel 0.5 las salidas van el doble de espaciadas; con 1.5, un tercio menos.
let rateLevel=1;
const afterLaunch=()=>{nextLaunchAt=Date.now()+launchSpacingMs({minSec:LAUNCH_GAP_MIN_SEC,maxSec:LAUNCH_GAP_MAX_SEC,breakProb:LAUNCH_BREAK_PROB,scale:rateLevel});};
let xianyuStatus={};
let firstStatus=true;
// Estado de Xianyu según el servidor: minutos de parada, ritmo y factor de rendimiento de cada modelo.
let yieldFactor={};
// Espera (como mucho maxMin) a que se pueda buscar: Mac conectado, transición de IP terminada, por debajo del tope por hora.
// Devuelve 'ok' | 'blocked' (bloqueo de red) | 'unavailable'. Mientras espera no se gasta ningún turno.
async function awaitAvailable(maxMin){
  const until=Date.now()+maxMin*60e3;
  let said=false;
  while(true){
    const blocked=await xianyuBlockMinutes();
    if(blocked>0)return 'blocked';
    if(xianyuStatus.available!==false)return 'ok';
    const waitMin=Math.max(1,Math.min(5,Number(xianyuStatus.wait_min)||2));
    if(Date.now()+waitMin*60e3>until)return 'unavailable';
    if(!said){console.log(`Xianyu no disponible ahora (${xianyuStatus.unavailable_reason||'espera'}); espero sin gastar turnos.`);said=true;}
    await sleep(waitMin*60e3);
  }
}
// Rotación por rendimiento: el modelo que trae más anuncios nuevos tiene un intervalo más corto (hasta la mitad) y el que
// casi nunca trae nada, más largo (hasta el doble). El Radar tiene su propio intervalo y no se ajusta.
function adjustTasks(list){
  return list.map(t=>{
    const f=Number(yieldFactor[t.id]);
    if(!f||!t.interval_minutes||/^radar\b/i.test(String(t.task_name||'')))return t;
    return {...t,interval_minutes:Math.max(15,Math.round(Number(t.interval_minutes)/f))};
  });
}
async function xianyuBlockMinutes(){
  try{
    const st=await api('GET','/api/xianyu/status');
    xianyuStatus=st;
    if(Number.isFinite(Number(st.rate))&&Number(st.rate)>0)rateLevel=Number(st.rate);
    yieldFactor=st.yield_factor||{};
    // La primera salida de una ejecución cuenta desde la última búsqueda real (aunque fuera de la ejecución anterior).
    if(firstStatus){
      firstStatus=false;
      if(Number.isFinite(Number(st.last_search_ago_sec))){
        const base=LAUNCH_GAP_MIN_SEC*1000/Math.max(0.2,rateLevel);
        nextLaunchAt=Math.max(nextLaunchAt,Date.now()+Math.max(0,base-Number(st.last_search_ago_sec)*1000));
      }
    }
    return Number(st.hard_block_min)||0;
  }catch{return 0;}
}
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
  // Intervalos que mandan sobre los de la configuración cifrada (regla de Nil, 11-11-2026: el Radar de
  // oportunidades tiene la máxima prioridad, como los modelos de 60 min). Formato: "Nombre=minutos,Otro=minutos".
  const intervalOverrides=Object.fromEntries(String(process.env.TASK_INTERVAL_OVERRIDES??'Radar oportunidades=30')
    .split(',').map(x=>x.split('=').map(y=>y.trim())).filter(([k,v])=>k&&Number(v)>0).map(([k,v])=>[k,Number(v)]));
  for(const t0 of cfg.tasks||[]){
    const t=intervalOverrides[t0.task_name]?{...t0,interval_minutes:intervalOverrides[t0.task_name]}:t0;
    if(t!==t0)console.log(`Intervalo de ${t.task_name}: ${t0.interval_minutes} → ${t.interval_minutes} min (prioridad máxima, mucha presencia).`);
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
  const runAllTasks=shouldRunAllTasks({
    eventName:process.env.GITHUB_EVENT_NAME,
    autoChain:process.env.LH_AUTO_CHAIN==='1',
    loopMinutes:LOOP_MINUTES
  });
  const globalEmail=cfg.global_email||{};
  let cycle=0;
  while(true){
    cycle++;
    const cycleStartedAt=Date.now();
    if(cycle>1)budgetStartedAt=cycleStartedAt;
    await xianyuBlockMinutes();
    let tasks=adjustTasks((await api('GET','/api/tasks')).tasks||[]);
    // Las ejecuciones encadenadas respetan interval_minutes de cada modelo.
    // Solo un lanzamiento manual real fuerza todas las tareas activas.
    let runnable=runAllTasks
      ? tasks.filter(t=>t.enabled)
      : tasks.filter(t=>due(t));
    if(!runnable.length&&cycle===1&&IDLE_WAIT_MAX_MINUTES>0){
      const next=nextDueTask(tasks);
      if(next&&next.ms<=IDLE_WAIT_MAX_MINUTES*60000){
        console.log(`Todavía no toca ningún modelo; espero ${Math.ceil(next.ms/60000)} min hasta ${next.task.task_name} para no cortar la cadena.`);
        await sleep(next.ms+5000);
        budgetStartedAt=Date.now();
        tasks=adjustTasks((await api('GET','/api/tasks')).tasks||[]);
        runnable=tasks.filter(t=>due(t));
      }
    }
    // El orden de salida lo decide más abajo rankLaunches (urgencia repartida), no un orden fijo por niveles.
    // Pasada de subastas (regla de Nil, 07-11-2026): en cada ciclo, todos los
    // modelos activos buscan en One Map las subastas que acaban en ≤2 h y
    // tienen alguna puja. Solo One Map por el Chrome del Mac, sin Mercari ni Xianyu.
    if(ACTIVE_SOURCES.includes('buyee')&&!['0','off','false','no'].includes(String(process.env.AUCTION_LANE||'').toLowerCase())){
      const full=new Set(runnable.map(t=>t.id));
      const auctionList=tasks.filter(t=>t.enabled&&!full.has(t.id)&&(t.sources||[]).includes('buyee')&&(t.japan_queries||[]).length);
      await runPool(auctionList,Math.min(2,TASK_CONCURRENCY),async task=>{
        try{
          const q=await api('POST',`/api/tasks/${task.id}/run`,{fast:'auction'});
          if(q.skipped)return;
          anyTaskStarted=true;
          console.log(`\n=== SUBASTAS ${task.task_name} (One Map, ≤2 h) ===`);
          const run=await waitRun(q.runId);
          console.log(`DONE subastas ${task.task_name}: ${run.status}`);
        }catch(e){console.error(`FAILED subastas ${task.task_name}:`,e?.message||e);}
      });
    }
    const estimate=taskMinutesEstimate();
    let launched=0;
    let stopLaunching=false;
    const taskResults=[];
    hardBlockedMin=await xianyuBlockMinutes();
    if(hardBlockedMin>0)console.log(`Xianyu parado por un bloqueo de red: quedan ${hardBlockedMin} min. No se lanza ninguna búsqueda.`);
    // Revisiones completas que tocan + carril rápido de los demás modelos que también tocan (se consulta, sin lanzar).
    const items=[];
    if(!hardBlockedMin){
      for(const t of runnable)items.push({task:t,mode:'full'});
      if(FAST_TASKS.length){
        const full=new Set(runnable.map(t=>t.id));
        for(const t of tasks.filter(x=>FAST_TASKS.includes(x.task_name)&&!full.has(x.id))){
          try{
            const q=await api('POST',`/api/tasks/${t.id}/run`,{fast:true,probe:true});
            if(q.due)items.push({task:t,mode:'fast',sinceMin:q.since_min});
          }catch(e){console.error(`Consulta rápida ${t.task_name}:`,e?.message||e);}
        }
      }
    }
    const ranked=rankLaunches(items,{laneMinutes:Number(process.env.FAST_LANE_MINUTES)||60});
    console.log(`\n##### CICLO ${cycle}: ${runnable.length}/${tasks.length} revisiones completas + ${ranked.length-runnable.length} del carril rápido, concurrencia ${TASK_CONCURRENCY}${RUN_BUDGET_MINUTES?`, máximo ${RUN_BUDGET_MINUTES} min`:''} #####`);
    if(ranked.length)console.log('Orden de salida (más urgente primero): '+ranked.map(x=>`${x.task.task_name}${x.mode==='fast'?' (rápido)':''} ${x.urgency.toFixed(2)}`).join(' · '));
    await runPool(ranked,TASK_CONCURRENCY,async item=>{
      const task=item.task,fast=item.mode==='fast';
      try{
        const q=await launchGate(async()=>{
          if(hardBlockedMin>0||stopLaunching)return null;
          if(RUN_BUDGET_MINUTES&&launched>0&&elapsedMinutes()+estimate(task.id)>RUN_BUDGET_MINUTES)return null;
          // Antes de gastar el turno de un modelo, comprobar que Xianyu puede buscar (Mac conectado, sin transición de IP,
          // sin tope por hora). Si no, se espera sin gastar nada; si no se arregla, la ejecución acaba y reintenta luego.
          const av=await awaitAvailable(RUN_BUDGET_MINUTES?Math.max(2,Math.min(30,RUN_BUDGET_MINUTES-elapsedMinutes())):30);
          if(av==='blocked'){hardBlockedMin=Number(xianyuStatus.hard_block_min)||1;console.log(`Xianyu se ha bloqueado (quedan ${hardBlockedMin} min): no salen más tareas.`);return null;}
          if(av==='unavailable'){stopLaunching=true;console.log(`Xianyu sigue sin poder buscar (${xianyuStatus.unavailable_reason||'espera'}): no salen más tareas en esta ejecución; ningún modelo se da por revisado.`);return null;}
          const r=await api('POST',`/api/tasks/${task.id}/run`,fast?{fast:true}:{});
          if(r.skipped)return null;
          launched++;
          anyTaskStarted=true;
          afterLaunch();
          return r;
        });
        if(!q)return;
        console.log(fast?`\n=== RÁPIDO ${task.task_name} (${FAST_LABEL}) ===`:`\n=== RUN ${task.task_name} ===`);
        const run=await waitRun(q.runId);
        // Si Xianyu no llegó a buscar, no hay que esperar la pausa de una búsqueda que no ocurrió.
        try{
          const xs=JSON.parse(run.source_status_json||'{}').xianyu;
          if(xs&&(xs.state==='paused'||xs.state==='throttled'))nextLaunchAt=Math.min(nextLaunchAt,Date.now()+3000);
        }catch{}
        if(fast)console.log(`DONE rápido ${task.task_name}: ${run.status}`);
        else{
          taskResults.push({task_id:task.id,task_name:task.task_name,status:run.status,run_id:q.runId});
          console.log(`DONE ${task.task_name}: ${run.status}`);
        }
      }catch(e){
        if(!fast)taskResults.push({task_id:task.id,task_name:task.task_name,status:'error',error:e?.message||String(e)});
        console.error(`FAILED ${fast?'rápido ':''}${task.task_name}:`,e?.message||e);
      }
    });
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

    if(hardBlockedMin>0){
      console.log('Xianyu parado por bloqueo de red: la ejecución termina; la siguiente espera a que acabe la parada.');
      break;
    }
    if(stopLaunching){
      console.log('Xianyu no ha podido buscar en esta ejecución; termina y se reintenta en la siguiente (los modelos siguen pendientes).');
      break;
    }
    const cycleMinutes=(Date.now()-cycleStartedAt)/60000;
    console.log(`Ciclo ${cycle} completado en ${cycleMinutes.toFixed(1)} min.`);
    if(RUN_MIN_MINUTES&&anyTaskStarted&&!runAllTasks){
      const sinceStart=(Date.now()-workerStartedAt)/60000;
      const left=RUN_MIN_MINUTES-sinceStart;
      if(left>0.5){
        console.log(`Ejecución corta (${sinceStart.toFixed(1)} min): sigo ${Math.round(left)} min más en ciclos, para no encadenar ejecuciones sin parar.`);
        await sleep(Math.min(left,Math.max(CYCLE_MIN_MINUTES,5))*60000);
        continue;
      }
    }
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
  if(process.env.GITHUB_OUTPUT){
    // Una ejecución que no pudo lanzar nada (Mac en transición, parada...) también encadena la siguiente: antes se quedaba
    // el bot parado horas porque el cron de GitHub no es fiable. Para no encadenar en bucle, dura como mínimo 5 min.
    try{
      const ranSec=(Date.now()-workerStartedAt)/1000;
      if(!anyTaskStarted&&ranSec<300)await sleep((300-ranSec)*1000);
      fs.appendFileSync(process.env.GITHUB_OUTPUT,`started=true\n`);
    }
    catch(e){console.error('Could not report task-start status:',e.message);}
  }
  if(child.exitCode===null && child.signalCode===null){
    child.kill('SIGTERM');

    // Margen largo para que el servidor cierre la base de datos (un corte a la fuerza a media escritura la estropeaba).
    await Promise.race([
      new Promise(resolve=>child.once('exit',resolve)),
      sleep(30000)
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
