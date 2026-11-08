// BÚSQUEDA POR DESCRIPCIÓN (regla de Nil, 08-11-2026): de todas las fichas del
// modelo se sacan las 100 de descripción más parecida a la del anuncio, y esas
// son las que pasan al check con imagen. La columna «Descripción IA» de la hoja
// tiene siempre la misma forma («Marca Modelo Talla · medidas · material ·
// color · rasgos»); la IA describe el anuncio igual, en español, y aquí se
// comparan las palabras. Las palabras raras dentro del modelo (cannage, charms,
// tweed...) pesan más que las que tienen casi todas las fichas.
const norm=t=>String(t||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
const STOP=new Set(('de del la las el los un una unos unas y o e a en con sin por para al su sus que se es tipo confirmar confirmado '+
  'foto fotos visible visibles ficha segun indicado indicada revisar ve parece bolso bolsa modelo color material cm').split(' '));
// Cómo se escribe lo mismo de varias maneras en las fichas.
const SAME=[[/^(piel|leather|calfskin|becerro|ternera)$/,'cuero'],[/^(monogram|monograma|monogramas)$/,'monograma'],
  [/^(acolchad[oa]s?|quilted|matelasse|capitone)$/,'acolchado'],[/^(cadenas?|chain)$/,'cadena'],[/^(correas?|bandoleras?|strap)$/,'correa'],
  [/^(asas?|handles?)$/,'asa'],[/^(herrajes?|hardware)$/,'herraje'],[/^(dorad[oa]s?|gold|oro)$/,'dorado'],[/^(platead[oa]s?|silver|plata)$/,'plateado'],
  [/^(cremalleras?|zip)$/,'cremallera'],[/^(solapas?|flap)$/,'solapa'],[/^(charms?|colgantes?)$/,'charm'],[/^(lisa?|smooth)$/,'liso'],
  [/^(granulad[oa]|grained|caviar)$/,'granulado'],[/^(lona|canvas|toile)$/,'lona']];
const canon=w=>{for(const [re,to] of SAME)if(re.test(w))return to;return w.length>4&&w.endsWith('s')?w.slice(0,-1):w;};
export function descTokens(text){
  const out=new Set();
  for(const w of norm(text).replace(/tipo sin confirmar/g,' ').split(/[^a-z]+/)){
    if(w.length<3||STOP.has(w))continue;
    out.add(canon(w));
  }
  return out;
}
const rowText=r=>r?.desc||[r?.model,r?.size,r?.material,r?.color,r?.notes].filter(Boolean).join(' ');
export function descIndex(rows){
  const df=new Map(),tokens=new Map();
  for(const r of rows||[]){
    const t=descTokens(rowText(r));
    tokens.set(r,t);
    for(const w of t)df.set(w,(df.get(w)||0)+1);
  }
  const n=Math.max(1,tokens.size);
  const idf=w=>Math.log(1+n/(1+(df.get(w)||0)));
  const weight=set=>[...set].reduce((s,w)=>s+idf(w),0);
  return {tokens,idf,weight};
}
// 0 a 1: cuánto de lo que dice el anuncio está en la ficha (y un poco de lo
// contrario, para que una ficha que describe otra cosa más no salga delante).
export function descScore(index,query,row){
  const t=index?.tokens.get(row);
  if(!t||!query?.size)return 0;
  let both=0;
  for(const w of query)if(t.has(w))both+=index.idf(w);
  const q=index.weight(query),r=index.weight(t);
  if(!(q>0))return 0;
  return 0.7*both/q+0.3*(2*both/(q+r||1));
}
// La propia hoja duda de esa ficha: el modelo, la versión o el material «a
// revisar» (el color a revisar no descarta: puede variar). No sirve de prueba.
export const refSheetDoubt=r=>/(modelo|versi[oó]n|material|talla)\s+a\s+revisar/i.test(String(r?.desc||''));
