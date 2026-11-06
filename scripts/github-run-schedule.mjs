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
export const WATCH_TASK_RE=/speedmaster|seamaster|rolex|tudor|grand seiko|\bseiko\b|cartier (santos|tank|ballon)|\biwc\b|jaeger|breitling|patek|audemars|panerai|tag heuer|\bheuer\b|\breloj|\bwatch/i;
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
