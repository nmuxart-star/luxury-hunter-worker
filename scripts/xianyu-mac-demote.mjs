// Regla de Nil (20-11-2026): si el Chrome del Mac recibe 3 verificaciones de Xianyu en unas 3 h (porque Nil está usando el
// ordenador), el Mac deja de ser la vía prioritaria y el bot sale por la nube (tras la transición de IP de 2 h) aunque el Mac
// siga encendido. Se mantiene así hasta que el bot lleve unas horas buscando desde la nube con el Mac conectado (Nil usándolo)
// sin que ese uso provoque problemas; entonces el Mac vuelve a tener prioridad.
export const DEMOTE_DEFAULTS={verifs:3,windowMs:3*3600e3,recoverMs:4*3600e3,dedupeMs:10*60e3,tickMaxMs:15*60e3};
const cfg=o=>({...DEMOTE_DEFAULTS,...(o||{})});
const fresh=()=>({events:[],demote:null});
export function demoteFromEnv(env=process.env){
  const n=(k,d,mul)=>{const v=Number(env[k]);return Number.isFinite(v)&&v>0?v*mul:d;};
  return {verifs:Math.max(1,Math.round(n('XIANYU_MAC_DEMOTE_VERIFS',DEMOTE_DEFAULTS.verifs,1))),
    windowMs:n('XIANYU_MAC_DEMOTE_WINDOW_H',DEMOTE_DEFAULTS.windowMs,3600e3),
    recoverMs:n('XIANYU_MAC_RECOVER_H',DEMOTE_DEFAULTS.recoverMs,3600e3)};
}
// Una verificación más en el Mac. La misma verificación sale en varias búsquedas seguidas: dentro de 10 min cuenta como una.
export function noteMacVerification(state,now=Date.now(),opts){
  const c=cfg(opts);const s=state&&typeof state==='object'?{events:[...(state.events||[])],demote:state.demote||null}:fresh();
  const last=s.events[s.events.length-1];
  if(last!==undefined&&now-last<c.dedupeMs)return s;
  s.events=[...s.events,now].filter(t=>now-t<=c.windowMs);
  if(!s.demote&&s.events.length>=c.verifs)s.demote={at:now,cloudMs:0,tick:null};
  return s;
}
export const isMacDemoted=s=>!!(s&&s.demote);
// Se llama cada vez que se decide la ruta. Suma tiempo de «bot en la nube con el Mac conectado» (tramos de máx. 15 min)
// y, cuando llega a recoverMs, levanta la degradación.
export function tickMacDemote(state,{now=Date.now(),macConnected,routeIsCloud},opts){
  const c=cfg(opts);if(!state||!state.demote)return state||fresh();
  const s={events:[...(state.events||[])],demote:{...state.demote}};
  if(routeIsCloud&&macConnected){
    if(s.demote.tick!=null)s.demote.cloudMs=(Number(s.demote.cloudMs)||0)+Math.min(Math.max(0,now-s.demote.tick),c.tickMaxMs);
    s.demote.tick=now;
  }else s.demote.tick=null;
  if(s.demote.cloudMs>=c.recoverMs)return fresh();
  return s;
}
