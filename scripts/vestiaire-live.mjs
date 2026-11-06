// VESTIAIRE EN DIRECTO
// Cuando la base de Nil (Sheets) no tiene ningún anuncio del modelo que se
// avisa, se busca ese modelo en Vestiaire desde el Chrome del Mac (puente de
// One Map) y la reventa sale de los anuncios del mismo modelo y material:
// primero los vendidos; si hay pocos, los pedidos × 92 %.
import {materialClass, modelNorm} from './vestiaire-model.mjs';
import {bagDimensions} from './vestiaire-bag-match.mjs';

export const VESTIAIRE_LIVE_REALIZATION=0.92;
const ORIGIN='https://es.vestiairecollective.com';
const known=v=>v&&!/unknown|desconocid|sin determinar/i.test(String(v));
const SIZES=[['nano',/\bnano\b/i],['micro',/\bmicro\b|マイクロ/i],['mini',/\bmini\b|ミニ|迷你/i],
  ['small',/\bsmall\b|peque[nñ]o|小号|スモール/i],['medium',/\bmedium\b|median[oa]|中号|ミディアム/i],
  ['large',/\blarge\b|\bgrande\b|大号|ラージ/i],['jumbo',/jumbo|ジャンボ/i],['maxi',/\bmaxi\b|マキシ/i],
  ['tpm',/\btpm\b/i],['pm',/\bpm\b/i],['mm',/\bmm\b/i],['gm',/\bgm\b/i],['bb',/\bbb\b/i]];
export const liveSizeOf=t=>(SIZES.find(([,re])=>re.test(String(t||'')))||[])[0]||null;

// Texto de búsqueda: marca + modelo identificados (sin repetir la marca).
export function vestiaireLiveQuery(item={},exact={}){
  const brand=String((known(exact.brand)&&exact.brand)||item.brand||'').trim();
  const family=String((known(exact.family)&&exact.family)||item.model||'').trim();
  const clean=t=>t.replace(/[^\p{Script=Latin}\d\s'&.-]/gu,' ').replace(/\s+/g,' ').trim();
  const fam=clean(family);
  if(fam.length<3)return null;
  const b=clean(brand);
  const q=b&&!modelNorm(fam).includes(modelNorm(b))?`${b} ${fam}`:fam;
  return q.slice(0,70).toLowerCase();
}

// Anuncio de la API de búsqueda de Vestiaire → fila como las de la hoja.
export function vestiaireLiveRows(payload){
  const items=Array.isArray(payload?.items)?payload.items:[];
  const seen=new Set();
  const out=[];
  for(const x of items){
    const id=Number(x?.id);
    const cents=Number(x?.price?.cents);
    // Solo bolsos: "Claude" de Celine también es una bota.
    if(!id||seen.has(id)||!(cents>0)||!/-bolsos\//.test(String(x?.link||'')))continue;
    seen.add(id);
    const slug=String(x.link).split('/').pop().replace(/-\d+\.shtml$/,'').replace(/-/g,' ');
    const dims=bagDimensions(x.description||'');
    out.push({id,url:`${ORIGIN}${x.link}`,title:String(x.name||''),brand:x.brand?.name||'',model:x.model?.name||'',
      price_eur:Math.round(cents)/100,sold:x.sold===true,likes:Number.isFinite(Number(x.likes))?Number(x.likes):null,
      color:x.colors?.all?.[0]?.name||'',condition:x.condition?.label||'',material:slug,
      size:liveSizeOf(`${x.name||''} ${x.description||''}`),dims:dims?dims.join('x'):'',notes:String(x.description||'').slice(0,300)});
  }
  return out;
}

// Franja de reventa con los anuncios del mismo modelo y material; misma talla
// si el anuncio la dice (si no hay 3 de su talla, todas las tallas, orientativo).
export function vestiaireLiveComparables(rows,item={},exact={},{query=null,model=null}={}){
  const itemMat=materialClass(known(exact.material)?exact.material:`${item.title||''} ${item.description||''}`);
  const brand=modelNorm(known(exact.brand)?exact.brand:item.brand||'').replace(/^yves /,'');
  let pool=(rows||[]).filter(r=>r.price_eur>0);
  if(brand)pool=pool.filter(r=>{const b=modelNorm(r.brand).replace(/^yves /,'');return !b||b.includes(brand)||brand.includes(b);});
  if(itemMat)pool=pool.filter(r=>materialClass(r.material)===itemMat);
  const size=liveSizeOf(`${known(exact.size)?exact.size:''} ${item.title||''}`);
  const sized=size?pool.filter(r=>r.size===size):[];
  let tier,set;
  if(sized.length>=3){tier='misma_talla';set=sized;}
  else if(pool.length>=3){tier='mismo_modelo';set=pool;}
  else return null;
  const sold=set.filter(r=>r.sold);
  const value=r=>r.sold?r.price_eur:r.price_eur*VESTIAIRE_LIVE_REALIZATION;
  const values=(sold.length>=3?sold:set).map(value).sort((a,b)=>a-b);
  const q=p=>Math.round(values[Math.round((values.length-1)*p)]);
  const mid=q(.5);
  const picks=set.slice().sort((a,b)=>(Number(b.sold)-Number(a.sold))||Math.abs(value(a)-mid)-Math.abs(value(b)-mid)).slice(0,5);
  return {source:'vestiaire_live',tier,query,model:model||set[0]?.model||null,material:itemMat,size,
    basis:tier==='misma_talla'?`talla ${size}`:size?`todas las tallas (solo ${sized.length} en ${size})`:'todas las tallas',
    n:values.length,total:set.length,sold_n:sold.length,active_n:set.length-sold.length,
    price_basis:sold.length>=3?'sold':'asking',low:q(.25),mid,high:q(.75),picks};
}
