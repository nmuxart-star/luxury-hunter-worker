import {sameModelRows, modelNorm, brandOf} from './vestiaire-model.mjs';

export const BAG_SHEET_RULE_VERSION=1;
const known=v=>v&&!/unknown|desconocid|sin determinar/i.test(String(v));

// Compare every declared axis, never just the largest side. A half centimetre
// allows rounding, not a neighbouring commercial size. Ambiguous sizes fail closed.
export function bagDimensions(text){
  const re=/(?<![\d.])(\d{1,3}(?:[.,]\d+)?)\s*(?:cm)?\s*[x×*✕]\s*(\d{1,3}(?:[.,]\d+)?)(?:\s*(?:cm)?\s*[x×*✕]\s*(\d{1,3}(?:[.,]\d+)?))?\s*(cm|mm|inches|inch|in\b|"|英寸)?/gi;
  const sets=[...String(text||'').matchAll(re)].map(m=>{
    if(m[4]&&m[4].toLowerCase()!=='cm')return null;
    const values=m.slice(1,4).filter(Boolean).map(x=>Number(x.replace(',','.'))).sort((a,b)=>a-b);
    return values.every(n=>n>0&&n<80)?values:null;
  });
  if(!sets.length||sets.some(x=>!x))return null;
  const distinct=[...new Map(sets.map(d=>[JSON.stringify(d),d])).values()];
  return distinct.length===1?distinct[0]:null;
}
export const sameBagDimensions=(a,b)=>!!(a&&b&&a.length===b.length&&a.every((n,i)=>Math.abs(n-b[i])<=0.5));

const MATERIALS=[
  ['synthetic',/faux|imitaci|sintetic|synthetic/],
  ['crocodile',/croc|alligator|caiman|鳄鱼/],['python',/python|piton|蟒/],['ostrich',/ostrich|avestruz|鸵鸟/],['lizard',/lizard|lagarto|蜥蜴/],
  ['patent',/charol|patent|vernis|漆皮|エナメル/],['suede',/\bante\b|suede|daim|scamosciato|麂皮|翻毛/],
  ['nylon',/nylon|nailon|poliamid|ナイロン|尼龙/],['wool',/\blana\b|wool|tweed|laine|ツイード/],
  ['silk',/seda|silk|satin|raso|丝绸/],['denim',/denim|vaquero/],['velvet',/velvet|terciopelo|ベロア/],
  ['canvas',/lona|canvas|toile|帆布|キャンバス/],['raffia',/raf+ia/],
  ['leather',/piel|cuero|leather|cuir|pelle|leder|lambskin|calfskin|caviar|cordero|becerro|ternera|vachetta|羊皮|牛皮|皮革|レザー|ラムスキン|カーフ|가죽/]
];
export const bagMaterial=t=>(MATERIALS.find(([,re])=>re.test(modelNorm(t)))||[])[0]||null;
const COLORS=[
  ['negro',/\b(negro|negra|black|noir|schwarz)\b|黑|ブラック/],['blanco',/\b(blanco|blanca|white|blanc|bianco)\b|白|ホワイト/],
  ['marron',/\b(marron|brown|brun)\b|棕|咖|ブラウン/],['azul',/\b(azul|blue|bleu)\b|蓝|ブルー/],
  ['rosa',/\b(rosa|pink|rose)\b|粉|ピンク/],['rojo',/\b(rojo|roja|red|rouge)\b|红|レッド/],
  ['burdeos',/\b(burdeos|burgundy|bordeaux)\b/],['amarillo',/\b(amarillo|yellow|jaune)\b|黄/],
  ['verde',/\b(verde|green|vert)\b|绿|グリーン/],['gris',/\b(gris|grey|gray)\b|灰|グレー/],
  ['beige',/\b(beige|ecru|crudo)\b/],['taupe',/\b(taupe|topo)\b/],['dorado',/\b(dorado|gold|golden|oro)\b/],
  ['plateado',/\b(plateado|silver|argent)\b/],['multicolor',/\b(multicolor|multicolore|multicolour)\b/]
];
function colour(text){
  const t=modelNorm(text);
  const keys=COLORS.filter(([,re])=>re.test(t)).map(([k])=>k);
  if(!keys.length)return null;
  const shade=/navy|marino/.test(t)?'marino':/claro|light|pastel/.test(t)?'claro':/oscuro|dark/.test(t)?'oscuro':'';
  return [...keys.sort(),shade].filter(Boolean).join('+');
}
const SIZES=[['micro',/\bmicro\b|マイクロ/],['nano',/\bnano\b/],['mini',/\bmini\b|ミニ|迷你/],['small',/\bsmall\b|peque|小号|スモール/],['medium',/\bmedium\b|mediano|中号|ミディアム/],['large',/\blarge\b|grande|大号|ラージ/],['pm',/\bpm\b/],['mm',/\bmm\b/],['gm',/\bgm\b/],['bb',/\bbb\b/]];
const sizeOf=t=>(SIZES.find(([,re])=>re.test(modelNorm(t)))||[])[0]||null;
export function bagCondition(text){
  const t=modelNorm(text).replace(/_/g,' ');
  if(/sin usar|unworn|\bnew\b|nuevo/.test(t))return 'UNWORN';
  if(/excellent|excelente/.test(t))return 'EXCELLENT';
  if(/very good|muy buen|tres bon/.test(t))return 'VERY_GOOD';
  if(/\bgood\b|buen estado|bon etat/.test(t))return 'GOOD';
  if(/\bfair\b|correcto|aceptable/.test(t))return 'FAIR';
  if(/\bpoor\b|mal estado/.test(t))return 'POOR';
  return null;
}
const valueOf=(f,ratio)=>f.sold
  ? (!f.sold_price_suspect&&Number.isFinite(f.sold_price_eur)&&f.sold_price_eur>0?f.sold_price_eur:null)
  : (!f.excluded&&Number.isFinite(f.price_eur)&&f.price_eur>0?f.price_eur*ratio:null);
const detail=(t,groups)=>(groups.find(([,re])=>re.test(modelNorm(t)))||[])[0]||null;
const LEATHERS=[['caviar',/caviar/],['lamb',/lamb|cordero|agneau|羊皮/],['calf',/calf|becerro|ternera|veau|牛皮/],['goat',/goat|cabra|chevre/]];
const PATTERNS=[['oblique',/oblique/],['ff',/\bff\b|zucca|zucchino/],['cannage',/cannage/],['plain',/\bplain\b|\bliso\b/]];
const HARDWARE=[['gold',/gold|dorado|oro/],['silver',/silver|plateado|argent/],['black',/black|negro/]];

export function strictBagComparables(entries,item={},exact={}){
  const raw=`${item.title||''} ${item.description||''}`;
  // Dimensions must be stated in the listing, never guessed from a photo.
  const dims=bagDimensions(raw);
  const mat=bagMaterial(known(exact.material)?exact.material:raw);
  if(!dims||!mat)return null;
  const size=sizeOf(`${exact.size||''} ${item.title||''}`);
  const color=colour(known(exact.main_color)?exact.main_color:(item.color||item.title));
  const condition=bagCondition(exact.condition?.grade||item.condition);
  const texts={title:item.title,label:[exact.brand,exact.family,exact.exact_variant_label,item.model].filter(Boolean).join(' '),description:item.description};
  const brand=brandOf(`${texts.title} ${texts.label}`);
  const leather=mat==='leather'?detail(exact.material,LEATHERS):null;
  const pattern=detail(exact.pattern,PATTERNS);
  const hardware=detail(exact.hardware,HARDWARE);
  let candidates=[];
  const groups=entries.map(({tab,rows})=>({tab,m:sameModelRows(tab,rows,texts,{requireNamed:true})})).filter(g=>g.m);
  const specificity=m=>modelNorm(m.key).split(' · ').pop().length;
  const mostSpecific=Math.max(0,...groups.map(g=>specificity(g.m)));
  // A broader model in another tab cannot substitute for the exact model,
  // even when the latter has no rows with the target's measurements.
  for(const {tab,m} of groups.filter(g=>specificity(g.m)===mostSpecific)){
    for(const f of m.rows){
      if(brand&&brandOf(f.brand)&&brand!==brandOf(f.brand))continue;
      if(!sameBagDimensions(dims,bagDimensions(f.dims)))continue;
      const rs=sizeOf(f.size);
      if(size&&rs&&size!==rs)continue;
      if(bagMaterial(f.material||f.notes)!==mat||valueOf(f,0.92)===null)continue;
      const rowLeather=detail(`${f.material} ${f.notes||''}`,LEATHERS);
      const rowPattern=detail(f.notes,PATTERNS);
      const hardwareText=String(f.notes||'').match(/(?:herrajes|hardware)[^;,.]{0,30}/i)?.[0]||'';
      const rowHardware=detail(hardwareText,HARDWARE);
      if((leather&&rowLeather&&leather!==rowLeather)||(pattern&&rowPattern&&pattern!==rowPattern)||(hardware&&rowHardware&&hardware!==rowHardware))continue;
      const detailsConfirmed=(!leather||rowLeather===leather)&&(!pattern||rowPattern===pattern)&&(!hardware||rowHardware===hardware)&&exact.special_edition!==true;
      // Never compare a different condition as though only its colour changed.
      if(condition&&bagCondition(f.condition)!==condition)continue;
      candidates.push({...f,tab,matched_model:m.key,details_confirmed:detailsConfirmed});
    }
  }
  candidates=[...new Map(candidates.map((f,i)=>[f.id||f.url||`${f.tab}:${i}`,f])).values()];
  const identical=color?candidates.filter(f=>colour(f.color)===color):[];
  // A missing colour is uncertainty, not evidence of a different colour.
  const alternatives=color?candidates.filter(f=>colour(f.color)&&colour(f.color)!==color):[];
  const selected=identical.length?identical:alternatives;
  if(!selected.length)return null;
  const tier=identical.length?'iguales':'misma_talla';
  const ratios=selected.filter(f=>f.sold&&f.price_eur>0&&valueOf(f,1)>0).map(f=>f.sold_price_eur/f.price_eur).filter(x=>x>0.4&&x<1.6).sort((a,b)=>a-b);
  const ratio=ratios.length>=5?Math.max(.75,Math.min(1,ratios[Math.floor(ratios.length/2)])):.92;
  const sales=selected.filter(f=>f.sold);
  const values=(sales.length?sales:selected).map(f=>valueOf(f,ratio)).sort((a,b)=>a-b);
  const q=p=>Math.round(values[Math.round((values.length-1)*p)]);
  const tabs=[...new Set(selected.map(f=>f.tab))];
  return {rule_version:BAG_SHEET_RULE_VERSION,tier,tab:tabs.join(', '),model:selected[0].matched_model,
    basis:`medidas declaradas ${dims.join(' × ')} cm`,colour:color,material:mat,
    condition, buy_eligible:dims.length===3&&!!condition&&Number(exact.confidence)>=.75&&Number(exact.condition?.confidence)>=.6&&selected.every(f=>f.details_confirmed),n:values.length,low:q(.25),mid:q(.5),high:q(.75),ratio,
    price_basis:sales.length?'sold':'asking',ratio_source:ratios.length>=5?'recorded_sales':'assumption',sold_n:sales.length,
    picks:selected.sort((a,b)=>Number(b.sold)-Number(a.sold)).slice(0,5)};
}

// Last deterministic gate: neither the LLM nor external market comparables can
// promote a bag without the requested evidence from a fresh Sheets read.
export function applyBagSheetPolicy(analysis,comps,{fresh=false}={}){
  const eligible=fresh&&comps?.rule_version===BAG_SHEET_RULE_VERSION&&comps.buy_eligible===true;
  const a={...analysis,sheet_match_rule_version:BAG_SHEET_RULE_VERSION};
  if(eligible)return a;
  const why=!fresh?'No se ha podido consultar una copia vigente de Sheets.'
    :!comps?'No hay referencia de Sheets con el mismo modelo, medidas y material y color conocido.'
    :'Falta confirmar las medidas completas, la variante o el estado frente a las referencias de Sheets.';
  if(['BUY','STRONG BUY','WATCH'].includes(a.decision)){
    a.decision='WATCH';
    a.opportunity_score=Math.min(Number(a.opportunity_score)||0,69);
    a.decision_reasons_es=[`CONSULTAR PRECIO: ${why} Posible oportunidad, sin compra recomendada.`,...(a.decision_reasons_es||[]).filter(r=>!String(r).startsWith('CONSULTAR PRECIO:'))].slice(0,5);
  }
  a.resale_estimate_market_verified=false;
  a.resale_estimate_confidence='LOW';
  a.resale_estimate_source='UNVERIFIED_ESTIMATE';
  return a;
}
