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
// 14-11-2026: el tope de «cuánto lleva de retraso» era 4 para todos y, con la cola llena, los relojes de nivel bajo (Grand Seiko,
// Rolex vintage, Aqua Terra…) se quedaban más de 24 h sin salir porque los de 60 min pesan más a igual retraso. Los relojes
// tienen ahora un tope mayor (WATCH_RATIO_CLAMP, 8): cuanto más tiempo esperan, más suben hasta que les toca. Y el Radar baja de
// peso (RADAR_WEIGHT, 1,3 en vez de 1,8) porque rinde menos por búsqueda. Sin variables, todo queda como antes (4 y 1,8).
export function launchUrgency(item,{now=Date.now(),rand=Math.random,laneMinutes=60,radarWeight=process.env.RADAR_WEIGHT??1.8,watchClamp=process.env.WATCH_RATIO_CLAMP??4}={}){
  const task=item.task;
  const interval=Number(task.interval_minutes)||0;
  let ratio;
  if(item.mode==='fast'){
    ratio=item.sinceMin==null?2:Number(item.sinceMin)/Math.max(5,laneMinutes);
  }else{
    const last=Date.parse(task.last_run_at||'');
    ratio=!Number.isFinite(last)||!interval?3:(now-last)/(interval*60000);
  }
  ratio=Math.min(isWatchTaskName(task.task_name)?Math.max(4,Number(watchClamp)||4):4,Math.max(0,ratio));
  let weight=item.mode==='fast'?0.8:1;
  if(interval&&interval<=60)weight*=1.3;
  // El Radar (bolsos fuera de la lista de Nil) tiene mucha presencia: sale casi siempre el primero.
  if(/^radar\b/i.test(String(task.task_name||'')))weight*=Number(radarWeight)||1.8;
  const tier=Number((String(task.description||'').match(/TIER:\s*(\d)/i)||[])[1])||9;
  if(isWatchTaskName(task.task_name)&&tier===1)weight*=1.15;
  return ratio*weight*(0.85+rand()*0.3);
}
export function rankLaunches(items,opts={}){
  return items.map(it=>({...it,urgency:launchUrgency(it,opts)})).sort((a,b)=>b.urgency-a.urgency);
}

// Pausa antes de la siguiente salida: entre minSec y maxSec, y de vez en cuando (breakProb) un descanso largo
// de breakMinMin–breakMaxMin minutos, como haría una persona. rand() en [0,1).
// scale (ritmo autorregulado) solo alarga o acorta la pausa normal; el descanso largo no se multiplica.
export function launchSpacingMs({minSec=270,maxSec=510,breakProb=0.15,breakMinMin=8,breakMaxMin=18,scale=1,rand=Math.random}={}){
  let ms=(minSec+rand()*(maxSec-minSec))*1000/Math.max(0.2,scale);
  if(rand()<breakProb)ms+=(breakMinMin+rand()*(breakMaxMin-breakMinMin))*60000;
  return Math.round(ms);
}

// CUPO EXTRA DEL RADAR (regla de Nil, 14-11-2026)
// Al subir un poco el ritmo de Xianyu, la parte que se gana va al Radar de oportunidades (bolsos de cualquier modelo, más
// nuevos primero), no a quitarle sitio a los modelos de Nil. Se añaden `extra` salidas del Radar a la cola ya ordenada,
// cada `every` salidas normales (la primera tras `every`). No cambia el orden de las demás ni quita ninguna de la cola;
// como el ritmo sube un poco a la vez, el hueco que ocupa el extra es el que se ha ganado. Si el tiempo de la ejecución
// se acaba, lo último en salir es lo que queda al final de la cola, como siempre.
export const isRadarTaskName=name=>/^radar\b/i.test(String(name||''));
export function withRadarExtras(ranked,radarTask,{extra=1,every=3}={}){
  const n=Math.max(0,Math.floor(Number(extra)||0));
  if(!n||!radarTask||!radarTask.enabled)return ranked;
  const step=Math.max(1,Math.floor(Number(every)||3));
  const out=[];let added=0,normal=0;
  const slot=()=>({task:radarTask,mode:'full',extra:true,urgency:0});
  for(const it of ranked){
    out.push(it);
    normal++;
    if(added<n&&normal===step*(added+1)){out.push(slot());added++;}
  }
  while(added<n){out.push(slot());added++;}
  return out;
}

// SALIDA EXTRA POR EJECUCIÓN: RELOJES ATRASADOS O RADAR (regla de Nil, 14-11-2026)
// El Radar rinde menos por búsqueda que los relojes (2,7 avisos por cada 100 búsquedas frente a 6,4), así que parte de su cupo
// extra pasa a los relojes que más llevan sin salir. El patrón (por defecto «watch,radar,watch») se recorre con el número de
// ejecución: 2 de cada 3 extras son un reloj atrasado y 1 de cada 3 es el Radar. Si no hay ningún reloj con retraso, va el Radar.
export function extraKindAt(index,pattern='watch,radar,watch'){
  const p=String(pattern||'').split(',').map(x=>x.trim().toLowerCase()).filter(x=>x==='watch'||x==='radar');
  return p.length?p[((Math.floor(Number(index)||0)%p.length)+p.length)%p.length]:'radar';
}
// El reloj con más retraso respecto a su intervalo (mínimo minRatio, para no repetir uno que acaba de salir), fuera de los excluidos.
export function pickStarvedWatch(watchTasks,exclude=new Set(),{now=Date.now(),minRatio=0.6}={}){
  let best=null;
  for(const t of watchTasks||[]){
    if(!t?.enabled||!Number(t.interval_minutes)||exclude.has(t.id)||!isWatchTaskName(t.task_name))continue;
    const last=Date.parse(t.last_run_at||'');
    const ratio=Number.isFinite(last)?(now-last)/(Number(t.interval_minutes)*60000):9;
    if(ratio<minRatio)continue;
    if(!best||ratio>best.ratio)best={task:t,ratio};
  }
  return best?best.task:null;
}
export function withExtraSlots(ranked,{radarTask=null,watchTasks=[],extra=1,every=3,runNumber=0,pattern='watch,radar,watch',now=Date.now()}={}){
  const n=Math.max(0,Math.floor(Number(extra)||0));
  if(!n)return ranked;
  const step=Math.max(1,Math.floor(Number(every)||3));
  const inQueue=new Set(ranked.map(x=>x.task.id));
  const used=new Set();
  const extras=[];
  for(let i=0;i<n;i++){
    let task=null;
    if(extraKindAt(runNumber+i,pattern)==='watch')task=pickStarvedWatch(watchTasks,new Set([...inQueue,...used]),{now});
    if(!task&&radarTask?.enabled&&!used.has(radarTask.id))task=radarTask;
    if(!task)continue;
    used.add(task.id);
    extras.push({task,mode:'full',extra:true,urgency:0});
  }
  const out=[];let added=0,normal=0;
  for(const it of ranked){
    out.push(it);normal++;
    if(added<extras.length&&normal===step*(added+1)){out.push(extras[added]);added++;}
  }
  while(added<extras.length){out.push(extras[added]);added++;}
  return out;
}

// TAREAS DESACTIVADAS (regla de Nil, 14-11-2026): lista de nombres (sin tildes ni mayúsculas) que el lanzador deja siempre apagadas aunque la
// configuración cifrada las traiga activas. Por defecto, «Alaia Le Teckel» (sin avisos y sin pestaña en la hoja).
export const nameFold=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
export const parseNameSet=text=>new Set(String(text??'').split(',').map(nameFold).filter(Boolean));
