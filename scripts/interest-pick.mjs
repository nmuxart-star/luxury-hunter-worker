// TAREAS DE 3 h, 6 h… (regla de Nil, 14-11-2026): no hace falta que los anuncios sean los más recientes; entre los de las
// últimas 24 h (el filtro de antigüedad ya lo garantiza) se analizan los que, por su precio, pueden ser más interesantes,
// con un tope por búsqueda (el «máx. de anuncios» de la tarea). Funciones puras para poder probarlas.

// ¿Esta tarea elige por interés en vez de por recientes? Las de intervalo largo (≥ minInterval min); el Radar no.
export const picksByInterest=(task,minInterval=180)=>
  Number(minInterval)>0&&Number(task?.interval_minutes)>=Number(minInterval)&&!/^radar\b/i.test(String(task?.task_name||''));

// items ya vienen ordenados de más a menos interesante. Se queda con los `cap` primeros; lo que hay que verificar (ya
// analizado antes y pendiente de comprobar) no cuenta para el tope y nunca se quita.
export function capByInterest(items,cap){
  const n=Math.max(1,Math.floor(Number(cap)||0));
  const kept=[],dropped=[];
  let used=0;
  for(const it of items||[]){
    if(it?._needsVerification){kept.push(it);continue;}
    if(used<n){kept.push(it);used++;}
    else dropped.push(it);
  }
  return {kept,dropped};
}

// SEGUNDA PÁGINA (regla de Nil, 14-11-2026): en las tareas de bolsos de 3 h o más, si la página 1 sale llena y todo es de las
// últimas 24 h, hay más anuncios del modelo dentro del margen que no se están viendo: se lee también la página 2.
// items: resultados ya leídos (con publishedAt ISO). Los que no traen fecha no cuentan para decidir.
export function pageIsSaturated(items,{minItems=28,maxAgeHours=24,now=Date.now()}={}){
  const list=Array.isArray(items)?items:[];
  if(list.length<minItems)return false;
  const times=list.map(it=>Date.parse(it?.publishedAt||'')).filter(Number.isFinite);
  if(!times.length)return false;
  return times.every(t=>now-t<=maxAgeHours*3600e3);   // ninguno de más de 24 h: el margen no se ha agotado
}
export function mergeUniqueById(a,b){
  const seen=new Set();const out=[];
  for(const it of [...(a||[]),...(b||[])]){
    const id=String(it?.id||'');
    if(id&&seen.has(id))continue;
    if(id)seen.add(id);
    out.push(it);
  }
  return out;
}
