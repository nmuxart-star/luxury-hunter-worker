// REFERENCIAS ELEGIDAS POR LA IA (regla de Nil, 06-11-2026; v2 07-11: solo las
// comprobadas con foto, sin precio orientativo)
// La IA no pone precio: mira el anuncio (modelo, talla, material, estado,
// calidad) y, una a una, las referencias de la hoja de Nil y de Vestiaire en
// directo, y dice cuáles son el MISMO producto con un estado parecido. Con
// esas, el bot calcula la media de precio (las vendidas, las recientes y las
// de más likes pesan más) y decide con los números.
import {compWeight,compStats,weightedQuantile} from './vestiaire-bag-match.mjs';

export const MATCH_VERSION='ai-refs-v2';
const refId=r=>String(r?.id||r?.url||'').match(/(\d{5,})(?:\.shtml)?$/)?.[1]||String(r?.id||r?.url||'');
const clip=(t,n)=>String(t??'').replace(/\s+/g,' ').trim().slice(0,n);

// Las que más pesan primero, como mucho `limit`; cada una con su código
// corto (B1, B2... para la base; V1... para Vestiaire) para el prompt.
export function refCandidates(rows,{prefix='B',limit=80,excludeId=null}={}){
  const ex=excludeId!=null?refId({id:excludeId}):null;
  const usable=(rows||[]).filter(r=>refValue(r,1)!=null&&(!ex||refId(r)!==ex));
  const seen=new Set();
  const out=[];
  for(const r of usable.slice().sort((a,b)=>compWeight(b)-compWeight(a))){
    const id=refId(r);
    if(id&&seen.has(id))continue;
    seen.add(id);
    out.push({...r,_code:`${prefix}${out.length+1}`});
    if(out.length>=limit)break;
  }
  return out;
}
// Una línea por referencia, corta, para que la IA las compare una a una.
export function refTable(cands){
  return (cands||[]).map(r=>[r._code,clip(r.model||r.title,40),clip(r.size,20),clip(r.dims,18),clip(r.material,40),clip(r.color,20),clip(r.condition,24),
    r.sold?'VENDIDO':'en venta',clip(r.published||String(r.created_at||'').slice(0,10),10),clip(r.notes,90)].join(' | ')).join('\n');
}
// Precio de una referencia: vendida, a su precio de venta; en venta, lo que
// pide × ratio (lo que de verdad se acaba vendiendo).
export function refValue(r,ratio=0.92){
  if(r?.sold){
    if(r.sold_price_suspect)return null;
    const v=Number(r.sold_price_eur)>0?Number(r.sold_price_eur):Number(r.price_eur);
    return v>0?v:null;
  }
  if(r?.excluded)return null;
  const v=Number(r?.price_eur);
  return v>0?v*ratio:null;
}
// Media ponderada y franja (p25–p75) de las referencias elegidas.
export function priceFromRefs(cands,codes,{ratio=0.92,prefer=[]}={}){
  const pref=new Set((prefer||[]).map(c=>String(c).trim().toUpperCase()));
  const want=new Set((codes||[]).map(c=>String(c).trim().toUpperCase()));
  const chosen=(cands||[]).filter(r=>want.has(String(r._code).toUpperCase()));
  const w=chosen.map(r=>({id:refId(r),s:!!r.sold,v:refValue(r,ratio),w:compWeight(r)})).filter(x=>x.v!=null&&x.w>0);
  if(!w.length)return null;
  const tw=w.reduce((s,x)=>s+x.w,0);
  const mean=Math.round(w.reduce((s,x)=>s+x.v*x.w,0)/tw);
  const q=p=>Math.round(weightedQuantile(w,p));
  const st=compStats(chosen);
  // Precio realista: la media o la mediana, la que sea más baja (una
  // referencia cara no infla el precio).
  return {n:w.length,mean,low:q(.25),mid:q(.5),high:q(.75),realistic:Math.min(mean,q(.5)),sold_n:st.sold_n,recent_n:st.recent_n,likes_max:st.likes_max,
    price_basis:st.sold_n?(st.sold_n===w.length?'sold':'mixed'):'asking',ratio,
    weighted:w.map(x=>({...x,v:Math.round(x.v),w:Math.round(x.w*100)/100})),
    // En el aviso, primero las del mismo color.
    picks:chosen.slice().sort((a,b)=>Number(pref.has(String(b._code).toUpperCase()))-Number(pref.has(String(a._code).toUpperCase()))||compWeight(b)-compWeight(a)).slice(0,5).map(({_code,...r})=>r)};
}
// Las dos juntas: la base de Nil pesa el doble; un anuncio que está en las
// dos cuenta una vez (como de la base).
export function combinePrices(base,live){
  if(!base&&!live)return null;
  if(!live)return {...base,source:'base'};
  if(!base)return {...live,source:'vestiaire'};
  const seen=new Set(base.weighted.map(x=>x.id));
  const all=[...base.weighted.map(x=>({...x,w:x.w*2})),...live.weighted.filter(x=>!seen.has(x.id))];
  const tw=all.reduce((s,x)=>s+x.w,0);
  const q=p=>Math.round(weightedQuantile(all,p));
  const mean=Math.round(all.reduce((s,x)=>s+x.v*x.w,0)/tw);
  return {source:'base+vestiaire',n:all.length,n_sheet:base.weighted.length,n_live:all.length-base.weighted.length,
    sold_n:all.filter(x=>x.s).length,mean,low:q(.25),mid:q(.5),high:q(.75),realistic:Math.min(mean,q(.5))};
}

// DECISIÓN CON LOS NÚMEROS
// Beneficio limpio = precio realista × (1 − comisión) − coste puesto. La nota final
// junta la calidad que ve la IA (la mitad) y el margen (la otra mitad).
// - Riesgo alto de autenticidad o no es el producto → REJECT.
// - Sin referencias iguales → como mucho WATCH (precio orientativo) o REVIEW.
// - STRONG BUY: beneficio ≥ 2 × mínimo, calidad ≥ 75 y ≥ 3 iguales.
// - BUY: beneficio ≥ mínimo y margen ≥ minMarginPct.
// - WATCH: beneficio ≥ 60 % del mínimo (posible oportunidad).
export function decideFromNumbers({price,landed,feePct=20,minProfit=200,minMarginPct=20,quality=null,risk='MEDIUM',targetMatch=true,orientative=false}){
  const q=Number.isFinite(Number(quality))?Math.max(0,Math.min(100,Number(quality))):50;
  if(targetMatch===false)return {decision:'REJECT',score:0,clean:null,margin:null,why:'no es el producto buscado'};
  if(String(risk).toUpperCase()==='HIGH')return {decision:'REJECT',score:Math.min(20,q),clean:null,margin:null,why:'riesgo alto de autenticidad'};
  const sale=Number(price?.realistic??price?.mean);
  if(!price||!(sale>0)||!(Number(landed)>0))return {decision:'REVIEW',score:null,clean:null,margin:null,why:'sin referencias iguales para calcular el precio'};
  const clean=Math.round(sale*(1-feePct/100)-Number(landed));
  const margin=Math.round(clean/Number(landed)*100);
  const marginScore=Math.max(0,Math.min(100,margin*2));
  let score=Math.round(q*0.5+marginScore*0.5);
  if(String(risk).toUpperCase()==='MEDIUM')score=Math.max(0,score-5);
  let decision;
  if(clean>=minProfit*2&&margin>=minMarginPct&&q>=75&&price.n>=3&&!orientative)decision='STRONG BUY';
  else if(clean>=minProfit&&margin>=minMarginPct&&!orientative)decision='BUY';
  else if(clean>=minProfit*0.6&&margin>=minMarginPct*0.75)decision='WATCH';
  else decision='REJECT';
  return {decision,score,clean,margin,why:decision==='REJECT'?`beneficio limpio ${clean} € (margen ${margin} %)`:''};
}
