// RADAR DE OPORTUNIDADES: PRIORIDAD DE MODELOS SEGÚN LA HOJA (regla de Nil, 12-11-2026; ampliada el 14-11-2026)
// Cada búsqueda de la lista rotativa del Radar es un modelo (p. ej. «圣罗兰 niki»). Con las fichas de la pestaña
// «Radar oportunidades» de la hoja se puntúa cada modelo: interés (likes), rotación (lo vendido) y representación
// (cuántas fichas hay). El Radar busca más a menudo los que más puntúan, sin dejar de pasar por los demás.
//
// 14-11-2026: además de la lista fija de la configuración, entran en la rotación los modelos de la hoja que aún no
// estaban en ella (los mejor puntuados, con fichas suficientes), con una búsqueda «marca-en-chino + modelo». Y una
// búsqueda que no trae nada dos veces seguidas pesa menos, para no gastar cupo de Xianyu en consultas que no rinden.
// Todo son funciones puras (sin base de datos ni red) para poder probarlas.

// [palabra de la marca en la búsqueda, clave interna]
export const RADAR_BRANDS=[['普拉达','prada'],['香奈儿','chanel'],['迪奥','dior'],['爱马仕','hermes'],['lv','louisvuitton'],['celine','celine'],['罗意威','loewe'],
  ['芬迪','fendi'],['圣罗兰','saintlaurent'],['戈雅','goyard'],['葆蝶家','bottega'],['古驰','gucci'],['miumiu','miumiu'],['蔻依','chloe'],
  ['巴黎世家','balenciaga'],['华伦天奴','valentino']];
export const RADAR_MODEL_ALIAS={'22bag':'22','box':'classic'};
export const radarNorm=x=>String(x||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');

export function radarQueryKey(q){
  const t=String(q||'').toLowerCase();
  const b=RADAR_BRANDS.find(([k])=>t.includes(k));
  const words=(t.match(/[a-z0-9]+/g)||[]).filter(w=>!['lv','celine','miumiu','bag'].includes(w)||/^22bag$/.test(w));
  const joined=words.join('');
  return {brand:b?b[1]:null,model:RADAR_MODEL_ALIAS[joined]||joined};
}

// Fichas de la pestaña que corresponden al modelo de una búsqueda (misma marca y el modelo dentro de la talla/tipo).
export function radarRowsFor(fichas,q){
  const k=radarQueryKey(q);
  if(!k.model)return [];
  return (fichas||[]).filter(f=>radarNorm(f.size).includes(k.model)&&(!k.brand||radarNorm(f.brand).includes(k.brand)));
}

export const RADAR_DEFAULT_WEIGHTS={likes:0.4,rotation:0.4,presence:0.2};
// «1,1,1» (likes, rotación, presencia) → pesos que suman 1; si no es válido, los de siempre.
export function radarParseWeights(text){
  const n=String(text||'').split(',').map(x=>Number(x.trim()));
  if(n.length!==3||n.some(x=>!Number.isFinite(x)||x<0)||!(n[0]+n[1]+n[2]>0))return RADAR_DEFAULT_WEIGHTS;
  const t=n[0]+n[1]+n[2];
  return {likes:n[0]/t,rotation:n[1]/t,presence:n[2]/t};
}
export function radarScoreModels(fichas,queries,weights=RADAR_DEFAULT_WEIGHTS){
  const pct=(vals,v)=>{const a=[...vals].sort((x,y)=>x-y);if(a.length<2)return 0.5;let lo=a.findIndex(x=>x>=v-1e-9);if(lo<0)lo=a.length-1;return lo/(a.length-1);};
  const stats=queries.map(q=>{
    const rows=radarRowsFor(fichas,q);
    const likes=rows.map(f=>Number(f.likes)).filter(Number.isFinite).sort((a,b)=>a-b);
    const median=likes.length?likes[Math.floor(likes.length/2)]:0;
    const mean=likes.length?likes.reduce((a,b)=>a+b,0)/likes.length:0;
    const n=rows.length,sold=rows.filter(f=>f.sold).length;
    return {q,n,sold,likes:0.5*median+0.5*mean,ratio:(sold+1)/(n+10)};
  });
  const have=stats.filter(x=>x.n>0);
  const out=new Map();
  for(const x of stats){
    if(!x.n){out.set(x.q,{...x,score:0.35});continue;}
    const likesR=pct(have.map(y=>y.likes),x.likes);
    const rotR=0.5*pct(have.map(y=>y.ratio),x.ratio)+0.5*pct(have.map(y=>y.sold),x.sold);
    const repR=pct(have.map(y=>y.n),x.n);
    // Por defecto interés y rotación 40 % cada uno y representación 20 %; configurable (RADAR_WEIGHTS).
    out.set(x.q,{...x,score:weights.likes*likesR+weights.rotation*rotR+weights.presence*repR});
  }
  return out;
}

// Ordena la lista del Radar: primero la búsqueda más «urgente» = tiempo desde la última vez × peso del modelo (0,3–2,2).
// yieldFactor (opcional): {consulta: multiplicador} para las que últimamente no traen anuncios.
export function radarPrioritize(queries,fichas,now=Date.now(),last={},yieldFactor={},weights=RADAR_DEFAULT_WEIGHTS){
  const scores=radarScoreModels(fichas,queries,weights);
  const rated=queries.map(q=>{
    const sc=scores.get(q)?.score??0.35;
    const yf=Number(yieldFactor?.[q]);
    const w=(0.2+3*sc*sc)*(yf>0?yf:1);   // peso 0,3–2,2: el mejor sale ~7 veces más que el peor, y ninguno deja de salir
    const since=Math.max(1,(now-(Number(last[q])||0))/3600e3);
    return {q,w,urgency:since*w,score:sc};
  }).sort((a,b)=>b.urgency-a.urgency);
  return {order:rated.map(x=>x.q),rated};
}

// ── Modelos de la hoja que aún no están en la lista del Radar ───────────────────────────────────────────────────
const SIZE_WORDS=new Set(['mini','small','medium','large','toy','nano','jumbo','maxi','bb','pm','mm','gm','baby','petit','petite','grand','xl','xs','micro']);
// Nombres demasiado genéricos para una búsqueda por sí solos.
const GENERIC_MODEL=new Set(['classic','chain','tote','bag','clasp','box','wallet','flap','shopping','collage','monogramme','monogram','college','vintage','canvas','leather','shoulder','handbag','pochette','mini','small','medium','large']);

export function radarBrandKey(name){
  const n=radarNorm(name);
  if(!n)return null;
  if(n.includes('saintlaurent'))return 'saintlaurent';
  for(const [,key] of RADAR_BRANDS)if(n.includes(key))return key;
  return null;
}
const brandToken=key=>RADAR_BRANDS.find(([,k])=>k===key)?.[0]||null;

// «Alma BB» y «Alma PM» son el mismo modelo para buscar: «alma». Devuelve las palabras del modelo sin tallas, o null si no
// sirve para una búsqueda (con números sueltos, demasiado genérico o demasiado largo).
export function radarModelBase(size){
  const words=(String(size||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().match(/[a-z0-9]+/g)||[]).filter(w=>!SIZE_WORDS.has(w));
  if(!words.length||words.length>3)return null;
  if(!words.every(w=>/^[a-z]{3,}$/.test(w)))return null;
  if(words.length===1&&GENERIC_MODEL.has(words[0]))return null;
  return words.join(' ');
}

// Modelos de la hoja (de la pestaña Radar) que NO están ya en la lista de la configuración, ordenados por la misma
// puntuación (interés, rotación, representación). Devuelve [{q,brand,model,n,score}] con una consulta «marca-en-chino modelo».
export function radarAutoQueries(fichas,configQueries,{max=15,minFichas=8,minScore=0.45}={}){
  if(!(max>0)||!Array.isArray(fichas)||!fichas.length)return [];
  const config=(configQueries||[]).map(radarQueryKey).filter(k=>k.model);
  const covered=(brand,modelNorm)=>config.some(k=>(!k.brand||k.brand===brand)&&(modelNorm.includes(k.model)||k.model.includes(modelNorm)));
  const groups=new Map();
  for(const f of fichas){
    const brand=radarBrandKey(f.brand);
    const base=radarModelBase(f.size);
    if(!brand||!base)continue;
    const key=brand+'|'+base;
    const g=groups.get(key)||{brand,base,n:0};
    g.n++;groups.set(key,g);
  }
  const cands=[];
  for(const g of groups.values()){
    if(g.n<minFichas)continue;
    const modelNorm=radarNorm(g.base);
    if(covered(g.brand,modelNorm))continue;
    const token=brandToken(g.brand);
    if(!token)continue;
    cands.push({q:`${token} ${g.base}`,brand:g.brand,model:modelNorm,n:g.n});
  }
  if(!cands.length)return [];
  // Se puntúan junto con los de la lista fija para que los percentiles sean comparables.
  const scores=radarScoreModels(fichas,[...(configQueries||[]),...cands.map(c=>c.q)]);
  const rated=cands.map(c=>({...c,score:scores.get(c.q)?.score??0})).filter(c=>c.score>=minScore).sort((a,b)=>b.score-a.score);
  const out=[];
  for(const c of rated){
    // «kelly» y «kelly to go» buscan casi lo mismo: se queda el mejor.
    if(out.some(o=>o.brand===c.brand&&(o.model.includes(c.model)||c.model.includes(o.model))))continue;
    out.push(c);
    if(out.length>=max)break;
  }
  return out;
}

// Multiplicador de peso según lo que han traído las últimas búsquedas de cada consulta.
// history: {consulta: [kept más reciente primero, ...]} contando solo búsquedas que de verdad se hicieron.
export function radarYieldFactors(history){
  const out={};
  for(const [q,arr] of Object.entries(history||{})){
    const a=(arr||[]).map(Number).filter(Number.isFinite).slice(0,3);
    if(a.length>=2&&a[0]===0&&a[1]===0)out[q]=0.3;                        // las dos últimas vacías: casi no se repite
    else if(a.length>=3&&a.reduce((x,y)=>x+y,0)/a.length<3)out[q]=0.7;    // trae muy poco
  }
  return out;
}

// ── PRECIO MÁXIMO POR MODELO (regla de Nil, 14-11-2026) ───────────────────────────────────────────────────────
// El Radar buscaba todos los modelos con el mismo rango de precio (600-2.200 €). Ahora, en cada búsqueda, el máximo sale del
// propio modelo: la media del precio de venta de sus fichas en la hoja (sin el 10 % más barato ni el 10 % más caro) y el precio
// MÁS ALTO de compra con el que, vendiéndolo a esa media, aún queda el margen mínimo (el mismo criterio del filtro de «caro»:
// beneficio limpio ≥ tolerance × beneficio mínimo). Así las 30 plazas de la página 1 son de anuncios que pueden ser rentables.
// El mínimo baja si hace falta (floorRatio del máximo) para que un modelo barato no se quede sin banda.
// values: precios de venta de referencia de las fichas (€); landedFn(precio) = coste puesto en España de un anuncio a ese precio.
// marginPct > 0 (14-11-2026: 30): el máximo es el que deja ese % de beneficio limpio sobre el coste puesto (en vez de un mínimo en euros).
export function radarPriceBand({values,fee=0.15,minProfit=200,landedFn,taskMin=null,taskMax=null,tolerance=0.6,floorRatio=0.4,minRefs=5,trim=0.1,marginPct=0}={}){
  const v=(values||[]).map(Number).filter(x=>Number.isFinite(x)&&x>0).sort((a,b)=>a-b);
  if(v.length<minRefs||typeof landedFn!=='function')return null;
  const cut=Math.floor(v.length*trim);
  const mid=v.slice(cut,v.length-cut);
  const resale=mid.reduce((a,b)=>a+b,0)/mid.length;
  const need=minProfit*tolerance;
  const ok=price=>{
    const landed=landedFn(price),clean=resale*(1-fee)-landed;
    return marginPct>0?clean>=landed*marginPct/100:clean>=need;
  };
  if(!ok(1))return null;                                   // ni regalado deja el margen mínimo
  let lo=1,hi=resale;                                      // el coste puesto siempre supera al precio: el máximo está por debajo de la venta
  for(let i=0;i<40;i++){const m=(lo+hi)/2;if(ok(m))lo=m;else hi=m;}
  let maxEur=Math.floor(lo/10)*10;
  if(Number(taskMax)>0)maxEur=Math.min(maxEur,Number(taskMax));
  if(!(maxEur>=30))return null;
  const floor=Math.round(maxEur*floorRatio/10)*10;
  const minEur=Number(taskMin)>0?Math.min(Number(taskMin),floor):floor;
  return {minEur,maxEur,resale:Math.round(resale),n:v.length};
}

// ── EL LISTADO DEL RADAR SALE DE LA BASE DE DATOS (regla de Nil, 14-11-2026) ──────────────────────────────────
// Antes: lista fija de 28 modelos escritos a mano + hasta 15 de la hoja. Ahora: se puntúan TODOS los modelos de la pestaña
// «Radar oportunidades» (los que tienen al menos minFichas fichas) por lo presentes que están (nº de fichas), su rotación (lo
// vendido) y su interés (likes), y el listado son los `size` mejores. Si un modelo ya tiene una búsqueda escrita a mano en la
// configuración, se usa esa (suele ir mejor); si no, «marca-en-chino modelo». Los modelos fijos que no puntúan alto salen.
// Devuelve [{q,score,n,sold,likes,fromConfig}] ordenado de más a menos puntuación.
export function radarBuildList(fichas,configQueries,{size=30,minFichas=8,weights=RADAR_DEFAULT_WEIGHTS}={}){
  if(!Array.isArray(fichas)||!fichas.length)return [];
  const config=(configQueries||[]).map(q=>({q,k:radarQueryKey(q)})).filter(x=>x.k.model);
  const cands=new Map();                       // clave de modelo → {q,fromConfig}
  const modelKey=(brand,model)=>`${brand||'*'}|${model}`;
  for(const c of config)cands.set(modelKey(c.k.brand,c.k.model),{q:c.q,fromConfig:true});
  const groups=new Map();
  for(const f of fichas){
    const brand=radarBrandKey(f.brand),base=radarModelBase(f.size);
    if(!brand||!base)continue;
    const key=brand+'|'+base;
    const g=groups.get(key)||{brand,base,n:0};
    g.n++;groups.set(key,g);
  }
  for(const g of groups.values()){
    if(g.n<minFichas)continue;
    const modelNorm=radarNorm(g.base);
    // ¿ya lo cubre una búsqueda de la configuración (misma marca y el modelo dentro del suyo, o al revés)?
    if(config.some(x=>(!x.k.brand||x.k.brand===g.brand)&&(modelNorm.includes(x.k.model)||x.k.model.includes(modelNorm))))continue;
    const token=brandToken(g.brand);
    if(!token)continue;
    const q=`${token} ${g.base}`;
    cands.set(modelKey(g.brand,modelNorm),{q,fromConfig:false});
  }
  const queries=[...cands.values()].map(x=>x.q);
  const scores=radarScoreModels(fichas,queries,weights);
  const rated=[...cands.values()].map(c=>{const sc=scores.get(c.q);return {q:c.q,fromConfig:c.fromConfig,score:sc?.score??0,n:sc?.n??0,sold:sc?.sold??0,likes:sc?.likes??0};})
    .filter(x=>x.n>=minFichas)                 // un modelo sin fichas suficientes no se puede puntuar: no entra
    .sort((a,b)=>b.score-a.score);
  // «kelly» y «kelly to go» buscan casi lo mismo: se queda el mejor.
  const out=[];
  for(const c of rated){
    const k=radarQueryKey(c.q);
    if(out.some(o=>{const ko=radarQueryKey(o.q);return ko.brand===k.brand&&(ko.model.includes(k.model)||k.model.includes(ko.model));}))continue;
    out.push(c);
    if(out.length>=size)break;
  }
  return out;
}
