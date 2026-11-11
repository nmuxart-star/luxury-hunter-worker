export function shouldRunAllTasks({eventName,autoChain=false,loopMinutes=0}={}) {
  return Number(loopMinutes)>0 || (eventName==='workflow_dispatch' && !autoChain);
}

// Un modelo toca cuando ha pasado su intervalo (con 2 min de margen).
const DUE_SLACK_MS=120000;
function nextRunAt(task){
  return Date.parse(task.last_run_at)+Number(task.interval_minutes)*60000-DUE_SLACK_MS;
}

export function isDue(task,now=new Date()){
  if(!task.enabled) return false;
  if(task.interval_minutes){
    if(!task.last_run_at) return true;
    return new Date(now).getTime()>=nextRunAt(task);
  }
  // GitHub Actions v1.5 is optimized for interval tasks. Cron tasks are left to the local scheduler.
  return false;
}

// Próximo modelo al que le toca y cuánto falta (null si ninguno tiene intervalo).
export function nextDueTask(tasks,now=Date.now()){
  const t0=new Date(now).getTime();
  let best=null;
  for(const task of tasks||[]){
    if(!task.enabled||!task.interval_minutes)continue;
    const at=task.last_run_at?nextRunAt(task):t0;
    const ms=Math.max(0,(Number.isFinite(at)?at:t0)-t0);
    if(!best||ms<best.ms)best={task,ms};
  }
  return best;
}

// RELOJES Y BOLSOS EN LA MISMA NUBE
// Los bolsos de prioridad 1 (cada 60 min) van siempre primero y los relojes
// no les quitan sitio. Después se alternan reloj y bolso de menos prioridad
// (reloj, bolso, reloj, bolso...) para que los relojes no se queden siempre
// a la cola. Como máximo `maxWatches` relojes por ejecución (por nivel y
// antigüedad); el resto pasa a la siguiente.
export const WATCH_TASK_RE=/speedmaster|seamaster|rolex|tudor|grand seiko|\bseiko\b|cartier (santos|tank|ballon|panth)|\biwc\b|jaeger|breitling|patek|audemars|panerai|tag heuer|\bheuer\b|\breloj|\bwatch/i;
export function isWatchTaskName(name){return WATCH_TASK_RE.test(String(name||''));}
export function planCycle(runnable,{maxWatches=Infinity}={}){
  const priority=t=>Number(t.interval_minutes)||Infinity;
  const age=t=>Date.parse(t.last_run_at||'')||0;
  const bags=runnable.filter(t=>!isWatchTaskName(t.task_name)).sort((a,b)=>(priority(a)-priority(b))||(age(a)-age(b)));
  // Niveles de relojes: "TIER: n" en la descripción (1 = más interesante).
  // Entre los relojes que toquen, primero el nivel más alto y luego el más antiguo.
  const tier=t=>Number((String(t.description||'').match(/TIER:\s*(\d)/i)||[])[1])||9;
  const watches=runnable.filter(t=>isWatchTaskName(t.task_name)).sort((a,b)=>(tier(a)-tier(b))||(age(a)-age(b)));
  const keep=watches.slice(0,Math.max(0,maxWatches));
  const first=bags.filter(t=>priority(t)<=60);
  const rest=bags.filter(t=>priority(t)>60);
  const mixed=[];
  for(let i=0;i<Math.max(keep.length,rest.length);i++){
    if(keep[i])mixed.push(keep[i]);
    if(rest[i])mixed.push(rest[i]);
  }
  return {tasks:[...first,...mixed],deferred:watches.slice(keep.length)};
}

// ORDEN DE SALIDA REPARTIDO (regla de Nil, 11-11-2026)
// Antes todos los bolsos de 60 min salían a la vez y luego el resto: una ráfaga que se atascaba en la cola de
// Xianyu. Ahora cada modelo (revisión completa o carril rápido) tiene una URGENCIA = cuánto se ha pasado de su
// intervalo (1 = justo ahora le toca, 2 = lleva el doble). Sale primero el más urgente; los de 60 min y el Radar
// pesan un poco más, el carril rápido un poco menos que una revisión completa, y una pizca de azar evita que
// el orden sea siempre idéntico. Lo que no cabe en una ejecución sube de urgencia y sale en la siguiente.
export function launchUrgency(item,{now=Date.now(),rand=Math.random,laneMinutes=60}={}){
  const task=item.task;
  const interval=Number(task.interval_minutes)||0;
  let ratio;
  if(item.mode==='fast'){
    ratio=item.sinceMin==null?2:Number(item.sinceMin)/Math.max(5,laneMinutes);
  }else{
    const last=Date.parse(task.last_run_at||'');
    ratio=!Number.isFinite(last)||!interval?3:(now-last)/(interval*60000);
  }
  ratio=Math.min(4,Math.max(0,ratio));
  let weight=item.mode==='fast'?0.8:1;
  if(interval&&interval<=60)weight*=1.3;
  // El Radar (bolsos fuera de la lista de Nil) tiene mucha presencia: sale casi siempre el primero.
  if(/^radar\b/i.test(String(task.task_name||'')))weight*=1.8;
  const tier=Number((String(task.description||'').match(/TIER:\s*(\d)/i)||[])[1])||9;
  if(isWatchTaskName(task.task_name)&&tier===1)weight*=1.15;
  return ratio*weight*(0.85+rand()*0.3);
}
export function rankLaunches(items,opts={}){
  return items.map(it=>({...it,urgency:launchUrgency(it,opts)})).sort((a,b)=>b.urgency-a.urgency);
}

// Pausa antes de la siguiente salida: entre minSec y maxSec, y de vez en cuando (breakProb) un descanso largo
// de breakMinMin–breakMaxMin minutos, como haría una persona. rand() en [0,1).
export function launchSpacingMs({minSec=270,maxSec=510,breakProb=0.15,breakMinMin=8,breakMaxMin=18,rand=Math.random}={}){
  let ms=(minSec+rand()*(maxSec-minSec))*1000;
  if(rand()<breakProb)ms+=(breakMinMin+rand()*(breakMaxMin-breakMinMin))*60000;
  return Math.round(ms);
}
