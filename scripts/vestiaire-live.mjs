// VESTIAIRE EN DIRECTO
// Cuando la base de Nil (Sheets) no tiene ningún anuncio del modelo que se
// avisa, se busca ese modelo en Vestiaire desde el Chrome del Mac (puente de
// One Map) y la reventa sale de los anuncios del mismo modelo y material:
// primero los vendidos; si hay pocos, los pedidos × 92 %.
import {materialClass, modelNorm} from './vestiaire-model.mjs';
import {bagDimensions,compWeight,compStats,weightedQuantile} from './vestiaire-bag-match.mjs';

export const VESTIAIRE_LIVE_REALIZATION=0.92;
const ORIGIN='https://es.vestiairecollective.com';
const known=v=>v&&!/unknown|desconocid|sin determinar/i.test(String(v));
const SIZES=[['nano',/\bnano\b/i],['micro',/\bmicro\b|マイクロ/i],['mini',/\bmini\b|ミニ|迷你/i],
  ['small',/\bsmall\b|peque[nñ]o|小号|スモール/i],['medium',/\bmedium\b|median[oa]|中号|ミディアム/i],
  ['large',/\blarge\b|\bgrande\b|大号|ラージ/i],['jumbo',/jumbo|ジャンボ/i],['maxi',/\bmaxi\b|マキシ/i],
  ['tpm',/\btpm\b/i],['pm',/\bpm\b/i],['mm',/\bmm\b/i],['gm',/\bgm\b/i],['bb',/\bbb\b/i]];
export const liveSizeOf=t=>(SIZES.find(([,re])=>re.test(String(t||'')))||[])[0]||null;

// Nombres de modelo distintos en Vestiaire: el Classic Flap de Chanel es
// "Timeless/Classique".
const VESTIAIRE_ALIASES=[[/classic flap|timeless|classique|11[.\s]?12|经典翻盖|マトラッセ/i,'chanel timeless classique']];
// Búsqueda por tarea (para las ofertas de Vestiaire): el nombre de la tarea,
// sin palabras de relleno; null si Vestiaire no tiene ese modelo.
export function vestiaireTaskQuery(taskName){
  const t=String(taskName||'');
  if(/radar|murakami/i.test(t))return null;
  const alias=VESTIAIRE_ALIASES.find(([re])=>re.test(t));
  if(alias)return alias[1];
  const q=modelNorm(t).replace(/[^a-z0-9 ]+/g,' ').replace(/\b(bag|bolso|matelasse)\b/g,' ').replace(/\s+/g,' ').trim();
  return q.length>=3?q.slice(0,70):null;
}
// Texto de búsqueda: marca + modelo identificados (sin repetir la marca).
export function vestiaireLiveQuery(item={},exact={}){
  const brand=String((known(exact.brand)&&exact.brand)||item.brand||'').trim();
  const family=String((known(exact.family)&&exact.family)||item.model||'').trim();
  const clean=t=>t.replace(/[^\p{Script=Latin}\d\s'&.-]/gu,' ').replace(/\s+/g,' ').trim();
  const fam=clean(family);
  const alias=VESTIAIRE_ALIASES.find(([re])=>re.test(`${family} ${brand}`)&&/chanel/i.test(`${brand} ${family} ${item.title||''}`));
  if(alias)return alias[1];
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
      size:liveSizeOf(`${x.name||''} ${x.description||''}`),dims:dims?dims.join('x'):'',notes:String(x.description||'').slice(0,300),
      picture:Array.isArray(x.pictures)&&x.pictures[0]?`https://images.vestiairecollective.com/images/resized/w=1024,q=75,f=jpg,${x.pictures[0]}`:`https://images.vestiairecollective.com/images/resized/w=1024,q=75,f=jpg,/produit/${id}-1_1.jpg`,
      created_at:Number(x.createdAt)>0?new Date(Number(x.createdAt)*1000).toISOString():null});
  }
  return out;
}

// Franja de reventa con los anuncios del mismo modelo y material; misma talla
// si el anuncio la dice (si no hay 3 de su talla, todas las tallas, orientativo).
// Cuentan todos (vendidos a su precio; en venta, pedido × 92 %), pero los
// vendidos, los recientes y los que tienen más likes pesan más (compWeight).
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
  const weighted=set.map(r=>({id:String(r.id),s:!!r.sold,v:value(r),w:compWeight(r)}));
  const q=p=>Math.round(weightedQuantile(weighted,p));
  const mid=q(.5);
  const picks=set.slice().sort((a,b)=>compWeight(b)-compWeight(a)).slice(0,5);
  return {source:'vestiaire_live',tier,query,model:model||set[0]?.model||null,material:itemMat,size,
    basis:tier==='misma_talla'?`talla ${size}`:size?`todas las tallas (solo ${sized.length} en ${size})`:'todas las tallas',
    n:set.length,total:set.length,sold_n:sold.length,active_n:set.length-sold.length,
    price_basis:sold.length===set.length?'sold':sold.length?'mixed':'asking',low:q(.25),mid,high:q(.75),
    recent_n:compStats(set).recent_n,likes_max:compStats(set).likes_max,
    weighted:weighted.map(x=>({...x,v:Math.round(x.v),w:Math.round(x.w*100)/100})),picks};
}

// Base de Nil + Vestiaire en directo. Las referencias de la base (mismas
// medidas, material, color y estado) pesan el doble; de Vestiaire solo entran
// las de la misma talla que no estén ya en la base. Dentro de cada grupo,
// vendidas y con más likes pesan más.
const refId=id=>String(id||'').match(/(\d{6,})(?:\.shtml)?$/)?.[1]||String(id||'');
export function blendComparables(sheet,live){
  if(!sheet?.weighted?.length||live?.status!=='ok'||live.tier!=='misma_talla')return null;
  const seen=new Set(sheet.weighted.map(x=>refId(x.id)));
  const extra=(live.weighted||[]).filter(x=>!seen.has(refId(x.id)));
  if(!extra.length)return null;
  const all=[...sheet.weighted.map(x=>({...x,w:x.w*2})),...extra];
  const q=p=>Math.round(weightedQuantile(all,p));
  return {n:all.length,n_sheet:sheet.weighted.length,n_live:extra.length,sold_n:all.filter(x=>x.s).length,
    low:q(.25),mid:q(.5),high:q(.75)};
}

// OFERTAS DENTRO DE VESTIAIRE
// Un anuncio en venta de Vestiaire es oferta si, comprándolo (precio + gastos
// de comprador) y revendiéndolo en Vestiaire (−20 % de comisión) a la parte
// baja de lo que valen los del mismo modelo, talla y material, deja al menos
// minProfitEur limpios y minMarginPct de margen. Comparables: los demás
// anuncios (los vendidos, los recientes y los de más likes pesan más). Los de estado
// "Correcto" no se proponen; los de "Buen estado" se valoran un 10 % más bajo.
export function vestiaireDeals(candidates,pool,{buyerFeePct=10,buyerShippingEur=20,sellFeePct=20,minProfitEur=200,minMarginPct=20,minComps=4,sizeOf:sizeFn=null}={}){
  const sizeOf=r=>(sizeFn&&sizeFn(r))||liveSizeOf(`${r.size||''} ${r.title||''} ${r.notes||''}`);
  const norm=(pool||[]).map(r=>({...r,_id:refId(r.id||r.url),_size:sizeOf(r),_mat:materialClass(String(r.material||'').trim()||r.notes),
    _value:r.sold?(Number(r.sold_price_eur)>0?Number(r.sold_price_eur):Number(r.price_eur)):(r.excluded?null:Number(r.price_eur)*VESTIAIRE_LIVE_REALIZATION)}))
    .filter(r=>Number.isFinite(r._value)&&r._value>0);
  // Un anuncio que está en la base y en Vestiaire en directo cuenta una vez,
  // como de la base (r._src==='base').
  const byId=new Map();
  for(const r of norm){const prev=byId.get(r._id);if(!prev||(r._src==='base'&&prev._src!=='base'))byId.set(r._id,r);}
  const pooled=[...byId.values()];
  const pickOf=r=>({url:r.url,title:r.title||'',size:r.size,color:r.color,condition:r.condition,price_eur:r.sold?(r.sold_price_eur??r.price_eur):r.price_eur,sold:!!r.sold,likes:r.likes,published:r.published||null,created_at:r.created_at||null});
  const out=[];
  for(const c of candidates||[]){
    const price=Number(c.price_eur);
    if(!(price>0)||c.sold)continue;
    if(/correcto|fair|aceptable/i.test(String(c.condition||'')))continue;
    const size=sizeOf(c), mat=materialClass(String(c.material||'').trim()||c.notes);
    if(!size||!mat)continue;
    const id=refId(c.id||c.url);
    const comps=pooled.filter(r=>r._id!==id&&r._size===size&&r._mat===mat);
    if(comps.length<minComps)continue;
    const weighted=comps.map(r=>({v:r._value,w:compWeight(r),s:!!r.sold}));
    const haircut=/^buen estado|^good/i.test(String(c.condition||'').trim())?0.9:1;
    const q=p=>Math.round(weightedQuantile(weighted,p)*haircut);
    const low=q(.25),mid=q(.5),high=q(.75);
    // Por separado, para el aviso: tu base y Vestiaire en directo.
    const part=src=>{
      const rows=comps.filter(r=>(r._src==='base')===(src==='base'));
      if(!rows.length)return {n:0};
      const w=rows.map(r=>({v:r._value,w:compWeight(r),s:!!r.sold}));
      const qq=p=>Math.round(weightedQuantile(w,p)*haircut);
      return {n:rows.length,...compStats(rows),low:qq(.25),mid:qq(.5),high:qq(.75),
        picks:rows.slice().sort((a,b)=>compWeight(b)-compWeight(a)).slice(0,3).map(pickOf)};
    };
    const cost=Math.round(price*(1+buyerFeePct/100)+buyerShippingEur);
    const net=r=>Math.round(r*(1-sellFeePct/100)-cost);
    const netLow=net(low),netHigh=net(high);
    if(netLow<minProfitEur||netLow/cost*100<minMarginPct)continue;
    out.push({...c,deal:{size,material:mat,n:comps.length,sold_n:weighted.filter(x=>x.s).length,low,mid,high,cost,net_low:netLow,net_high:netHigh,
      margin_pct:Math.round(netLow/cost*100),haircut:haircut<1,base:part('base'),live:part('live'),
      picks:comps.sort((a,b)=>compWeight(b)-compWeight(a)).slice(0,4).map(pickOf)}});
  }
  return out.sort((a,b)=>b.deal.net_low-a.deal.net_low);
}
