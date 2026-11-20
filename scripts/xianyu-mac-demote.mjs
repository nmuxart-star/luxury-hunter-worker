// Regla de Nil (20-11-2026): todo funciona como siempre (con el Mac encendido las búsquedas de Xianyu van al Mac; con el Mac
// apagado, a la nube; en cada ejecución se comprueba primero si el Mac está encendido). La ÚNICA excepción: si el Chrome del Mac
// recibe 3 verificaciones en ~3 h, el bot salta a la nube esperando la transición de IP (2 h) aunque el Mac siga encendido, y
// pasadas unas horas más (4 h) vuelve a comprobar si el Mac está encendido y, si lo está, retoma el Mac.
export const DEMOTE_DEFAULTS={verifs:3,windowMs:3*3600e3,switchMs:2*3600e3,recoverMs:4*3600e3,dedupeMs:10*60e3};
const cfg=o=>({...DEMOTE_DEFAULTS,...(o||{})});
const fresh=()=>({events:[],demote:null});
export function demoteFromEnv(env=process.env){
  const n=(k,d,mul)=>{const v=Number(env[k]);return Number.isFinite(v)&&v>0?v*mul:d;};
  return {verifs:Math.max(1,Math.round(n('XIANYU_MAC_DEMOTE_VERIFS',DEMOTE_DEFAULTS.verifs,1))),
    windowMs:n('XIANYU_MAC_DEMOTE_WINDOW_H',DEMOTE_DEFAULTS.windowMs,3600e3),
    switchMs:n('XIANYU_SWITCH_HOURS',DEMOTE_DEFAULTS.switchMs,3600e3),
    recoverMs:n('XIANYU_MAC_RECOVER_H',DEMOTE_DEFAULTS.recoverMs,3600e3)};
}
// Una verificación más en el Mac. La misma verificación sale en varias búsquedas seguidas: dentro de 10 min cuenta como una.
export function noteMacVerification(state,now=Date.now(),opts){
  const c=cfg(opts);const s=state&&typeof state==='object'?{events:[...(state.events||[])],demote:state.demote||null}:fresh();
  const last=s.events[s.events.length-1];
  if(last!==undefined&&now-last<c.dedupeMs)return s;
  s.events=[...s.events,now].filter(t=>now-t<=c.windowMs);
  if(!s.demote&&s.events.length>=c.verifs)s.demote={at:now,until:now+c.switchMs+c.recoverMs};
  return s;
}
// ¿Sigue el Mac degradado? Caduca solo: 2 h de espera + 4 h en la nube desde la tercera verificación; después se vuelve a comprobar el Mac.
export function macDemoteActive(state,now=Date.now()){return !!(state&&state.demote&&now<Number(state.demote.until));}
// Estado ya limpio si ha caducado (para guardarlo).
export function expireMacDemote(state,now=Date.now()){
  if(state&&state.demote&&!macDemoteActive(state,now))return fresh();
  return state||fresh();
}
