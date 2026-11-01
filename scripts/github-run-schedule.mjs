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
// Las tareas de relojes no deben quitar sitio a los bolsos: en cada ejecución
// se lanzan primero todos los bolsos que toquen (por prioridad) y, como
// máximo, `maxWatches` tareas de relojes (la que lleva más tiempo sin
// revisarse). El resto de relojes pasa a la siguiente ejecución.
export const WATCH_TASK_RE=/speedmaster|seamaster|rolex|tudor|grand seiko|\bseiko\b|cartier (santos|tank|ballon)|\biwc\b|jaeger|breitling|patek|audemars|panerai|\breloj|\bwatch/i;
export function isWatchTaskName(name){return WATCH_TASK_RE.test(String(name||''));}
export function planCycle(runnable,{maxWatches=1}={}){
  const priority=t=>Number(t.interval_minutes)||Infinity;
  const age=t=>Date.parse(t.last_run_at||'')||0;
  const bags=runnable.filter(t=>!isWatchTaskName(t.task_name)).sort((a,b)=>(priority(a)-priority(b))||(age(a)-age(b)));
  const watches=runnable.filter(t=>isWatchTaskName(t.task_name)).sort((a,b)=>age(a)-age(b));
  const keep=watches.slice(0,Math.max(0,maxWatches));
  return {tasks:[...bags,...keep],deferred:watches.slice(keep.length)};
}
