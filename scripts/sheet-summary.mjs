// PESTAÑA «RESUMEN» DE LA HOJA (regla de Nil, 14-11-2026)
// Primera pestaña de «Base de datos - Luxury Hunter»: precio medio de cada modelo repartido por variante (talla/tipo), material,
// color y estado, con cuántas fichas lo respaldan. El bot la lee para su primer filtro (precio de referencia por modelo) y para
// decir a cuánto tendría que bajar un anuncio descartado para dejar el margen mínimo. Funciones puras (sin red) + el CLI aparte.
import {materialClass} from './vestiaire-model.mjs';
import {radarModelBase} from './radar-priority.mjs';

export const SUMMARY_TAB='Resumen';
export const SUMMARY_HEADERS=['Tipo','Marca','Modelo','Variante','Material','Color','Estado','Nivel','Fichas','Vendidas','Pedido medio €','Mediana €','P25 €','P75 €','Vendido medio €','Precio de referencia €','Likes medios','Fiabilidad','Máx. compra con margen €'];
// Columnas (A=0 …). La S (18) es una fórmula que usa los parámetros de las columnas U:V.
export const SUMMARY_PARAMS=[
  ['Margen mínimo sobre el coste',0.30],['Comisión de reventa bolsos (Vestiaire)',0.20],['Comisión de reventa relojes (Chrono24)',0.065],
  ['Arancel bolsos',0.03],['Arancel relojes',0.045],['IVA de importación',0.21],['Comisión de pago (Alipay)',0.03],
  ['Envío internacional €',30],['Gestión de aduana €',25],['Verificación ¥',79],['Yuanes por euro (Revolut)',7.2947]
];
const LEVELS=[
  ['Modelo',[]],
  ['Modelo + variante',['variant']],
  ['Modelo + material',['material']],
  ['Modelo + color',['color']],
  ['Modelo + estado',['condition']],
  ['Modelo + variante + material',['variant','material']],
  ['Modelo + variante + color',['variant','color']],
  ['Modelo + variante + material + color',['variant','material','color']]
];

const fold=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
export const summaryNorm=s=>fold(s).replace(/[^a-z0-9]+/g,' ').trim();
const cap=s=>{const t=String(s||'').trim();return t?t.charAt(0).toUpperCase()+t.slice(1):t;};

export function sheetNum(v){
  if(typeof v==='number')return Number.isFinite(v)?v:null;
  const t=String(v??'').replace(/[€\s]/g,'');
  if(!t)return null;
  const n=Number(t.includes(',')&&t.includes('.')?t.replace(/\./g,'').replace(',','.'):t.replace(',','.'));
  return Number.isFinite(n)?n:null;
}

// Precio con el que cuenta una ficha en el bot: vendida → lo vendido (o lo pedido si no se sabe); a la venta → el 90 % de lo pedido.
export const refValueOf=f=>f.sold?(f.soldPrice>0?f.soldPrice:f.ask):f.ask*0.9;

// Una pestaña (fila 1 = cabecera) → fichas con las variables del resumen.
export function parseTabForSummary(values,tab,kind){
  const head=(values?.[0]||[]).map(h=>fold(h));
  const col=n=>head.indexOf(n);
  const c={brand:col('marca'),likes:Math.max(col('likes'),col('popularidad')),ref:col('referencia'),size:col('talla / tipo'),material:col('material'),
    color:col('color'),cond:col('estado'),price:col('precio €'),status:col('estado anuncio'),sold:col('precio venta €'),model:col('modelo')};
  if(c.ref<0||c.price<0)return [];
  const get=(r,i)=>i>=0?r[i]:'';
  const out=[];
  for(const row of (values||[]).slice(1)){
    const id=String(get(row,c.ref)||'').trim();
    if(!/^\d{5,10}$/.test(id))continue;
    if(/err[oó]ne|incorrect/i.test(String(get(row,c.status)||'')))continue;
    const ask=sheetNum(get(row,c.price));
    if(!(ask>0))continue;
    const sold=/vendido/i.test(String(get(row,c.status)||''));
    let soldPrice=sheetNum(get(row,c.sold));
    if(Number.isFinite(soldPrice)&&(soldPrice<ask*0.3||soldPrice>ask*3))soldPrice=null;      // referencia que apunta a otro artículo
    const brand=String(get(row,c.brand)||'').trim();
    const sizeRaw=String(get(row,c.size)||'').trim();
    const materialRaw=String(get(row,c.material)||'').trim();
    let tipo,model,variant,material;
    if(kind==='watch'){
      tipo='Reloj';
      model=String(get(row,c.model)||'').trim()||tab;
      variant=sizeRaw;                                                   // referencia del fabricante
      material=materialRaw;
    }else{
      tipo='Bolso';
      if(/^radar/i.test(tab)){
        const base=radarModelBase(sizeRaw);
        model=brand&&(base||sizeRaw)?`${brand} · ${cap(base||sizeRaw)}`:'';
      }else model=tab;
      variant=sizeRaw;
      material=cap(materialClass(materialRaw)==='tela'?'tela / sintético':materialClass(materialRaw)==='exotica'?'exótico':materialClass(materialRaw)==='piel'?'piel':'');
    }
    if(!model)continue;
    const color=String(get(row,c.color)||'').trim().replace(/^esfera\s+/i,'');
    out.push({tipo,brand,model,variant,material,color:cap(color),condition:String(get(row,c.cond)||'').trim(),ask,soldPrice,sold,likes:sheetNum(get(row,c.likes))});
  }
  return out;
}

const quantile=(a,p)=>a.length?a[Math.min(a.length-1,Math.max(0,Math.round((a.length-1)*p)))]:null;
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
function trimmedMean(a,trim=0.1){
  const s=[...a].sort((x,y)=>x-y);
  const cut=Math.floor(s.length*trim);
  return mean(s.slice(cut,s.length-cut));
}
export const reliabilityOf=n=>n>=10?'Alta':n>=5?'Media':n>=3?'Baja':'Muy baja';

// fichas (de todas las pestañas) → filas del resumen. Solo salen los segmentos con al menos minN fichas.
export function buildSummary(fichas,{minN=3}={}){
  const segs=new Map();
  for(const f of fichas){
    const dims={variant:f.variant,material:f.material,color:f.color,condition:f.condition};
    LEVELS.forEach(([name,need],li)=>{
      if(need.some(k=>!String(dims[k]||'').trim()))return;
      const key=[f.tipo,fold(f.brand),fold(f.model),li,...need.map(k=>fold(dims[k]))].join('|');
      let s=segs.get(key);
      if(!s){s={tipo:f.tipo,brand:f.brand,model:f.model,level:name,li,dims:Object.fromEntries(need.map(k=>[k,dims[k]])),asks:[],solds:[],refs:[],likes:[],soldN:0};segs.set(key,s);}
      s.asks.push(f.ask);
      if(f.sold)s.soldN++;
      if(f.sold&&f.soldPrice>0)s.solds.push(f.soldPrice);
      s.refs.push(refValueOf(f));
      if(Number.isFinite(f.likes))s.likes.push(f.likes);
    });
  }
  const rows=[];
  for(const s of segs.values()){
    const n=s.asks.length;
    if(n<minN)continue;
    const asks=[...s.asks].sort((a,b)=>a-b);
    rows.push({
      tipo:s.tipo,brand:s.brand,model:s.model,variant:s.dims.variant||'',material:s.dims.material||'',color:s.dims.color||'',condition:s.dims.condition||'',
      level:s.level,li:s.li,n,sold:s.soldN,
      askMean:Math.round(mean(asks)),median:Math.round(quantile(asks,0.5)),p25:Math.round(quantile(asks,0.25)),p75:Math.round(quantile(asks,0.75)),
      soldMean:s.solds.length?Math.round(mean(s.solds)):null,
      ref:Math.round(trimmedMean(s.refs)),
      likes:s.likes.length?Math.round(mean(s.likes)):null,
      reliability:reliabilityOf(n)
    });
  }
  rows.sort((a,b)=>a.tipo.localeCompare(b.tipo)||fold(a.brand).localeCompare(fold(b.brand))||fold(a.model).localeCompare(fold(b.model))||a.li-b.li||b.n-a.n||fold(a.variant+a.material+a.color+a.condition).localeCompare(fold(b.variant+b.material+b.color+b.condition)));
  return rows;
}

// Precio máximo de compra para el margen mínimo, con los parámetros de la pestaña (misma fórmula que la columna S).
export function maxPurchaseFromParams(ref,tipo,p){
  const watch=tipo==='Reloj';
  const fee=watch?p.feeWatch:p.feeBag,d=watch?p.dutyWatch:p.dutyBag;
  const a=1+d+p.vat*(1+d)+p.pay;
  const b=p.intl*(1+d)*(1+p.vat)+p.clearance+p.verifCny/p.fx;
  return Math.max(0,Math.round((ref*(1-fee)/(1+p.margin)-b)/a));
}
export function paramsFromList(list=SUMMARY_PARAMS){
  const v=list.map(x=>x[1]);
  return {margin:v[0],feeBag:v[1],feeWatch:v[2],dutyBag:v[3],dutyWatch:v[4],vat:v[5],pay:v[6],intl:v[7],clearance:v[8],verifCny:v[9],fx:v[10]};
}

// Filas → valores para la hoja: cabecera + filas + (en U:V) los parámetros. Última columna = fórmula del máximo de compra.
export function summaryToValues(rows,{params=SUMMARY_PARAMS,updated=''}={}){
  const out=[];
  const head=[...SUMMARY_HEADERS];
  out.push([...head,'','PARÁMETROS (editables)','']);
  rows.forEach((r,i)=>{
    const n=i+2;
    // La hoja está en español: los argumentos de las fórmulas van separados por «;».
    const W=`IF(A${n}="Reloj";$V$6;$V$5)`;
    const f=`=IF(P${n}="";"";MAX(0;ROUND((P${n}*(1-IF(A${n}="Reloj";$V$4;$V$3))/(1+$V$2)-($V$9*(1+${W})*(1+$V$7)+$V$10+$V$11/$V$12))/(1+${W}+$V$7*(1+${W})+$V$8);0)))`;
    out.push([r.tipo,r.brand,r.model,r.variant,r.material,r.color,r.condition,r.level,r.n,r.sold,r.askMean,r.median,r.p25,r.p75,r.soldMean??'',r.ref,r.likes??'',r.reliability,f]);
  });
  // parámetros en U2:V12 (+ fecha en U14)
  params.forEach(([label,val],i)=>{
    const row=out[i+1]||(out[i+1]=new Array(22).fill(''));
    while(row.length<22)row.push('');
    row[20]=label;row[21]=val;
  });
  const dRow=out[params.length+2]||(out[params.length+2]=new Array(22).fill(''));
  while(dRow.length<22)dRow.push('');
  dRow[20]='Actualizado';dRow[21]=updated;
  for(let i=0;i<out.length;i++)if(!out[i])out[i]=[];     // sin huecos (la API no admite filas vacías sin arreglo)
  return out;
}

// Lo que lee el bot: valores de la pestaña → filas con número de fichas y precio de referencia.
export function parseSummaryValues(values){
  const head=(values?.[0]||[]).map(h=>fold(h));
  const col=n=>head.indexOf(n);
  const c={tipo:col('tipo'),brand:col('marca'),model:col('modelo'),variant:col('variante'),material:col('material'),color:col('color'),cond:col('estado'),level:col('nivel'),n:col('fichas'),sold:col('vendidas'),ref:col('precio de referencia €')};
  if(c.model<0||c.ref<0||c.n<0)return [];
  const out=[];
  for(const row of (values||[]).slice(1)){
    const ref=sheetNum(row[c.ref]),n=sheetNum(row[c.n]);
    if(!(ref>0)||!(n>0))continue;
    out.push({tipo:String(row[c.tipo]||''),brand:String(row[c.brand]||''),model:String(row[c.model]||''),variant:String(row[c.variant]||''),material:String(row[c.material]||''),
      color:String(row[c.color]||''),condition:String(row[c.cond]||''),level:String(row[c.level]||''),n,sold:sheetNum(row[c.sold])||0,ref});
  }
  return out;
}

// El segmento más específico que haya para lo que se sabe del anuncio (cada paso necesita ≥ minN fichas, que ya garantiza la hoja).
// query: {tipo, model, variant, material, color}. Los modelos se comparan sin tildes ni signos; si no hay coincidencia exacta, vale
// que uno contenga al otro (p. ej. «Louis Vuitton · Alma» y «Alma»).
export function lookupSummary(rows,{tipo,model,variant='',material='',color=''}={},{minN=3}={}){
  const qm=summaryNorm(model);
  if(!qm)return null;
  let cands=(rows||[]).filter(r=>(!tipo||r.tipo===tipo)&&summaryNorm(r.model)===qm);
  if(!cands.length)cands=(rows||[]).filter(r=>(!tipo||r.tipo===tipo)&&(()=>{const m=summaryNorm(r.model);return m.includes(qm)||qm.includes(m);})());
  if(!cands.length)return null;
  const same=(a,b)=>summaryNorm(a)===summaryNorm(b);
  // La variante del anuncio suele ser corta («Mini») y la de la hoja larga («Mini Lady Dior»): vale que la contenga como palabras.
  const sameVar=(rowV,qV)=>{const r=` ${summaryNorm(rowV)} `,q=` ${summaryNorm(qV)} `;return r===q||(q.trim()&&r.includes(q));};
  const pick=(level,test)=>cands.filter(r=>r.level===level&&r.n>=minN&&test(r)).sort((a,b)=>b.n-a.n)[0]||null;
  const has=x=>!!String(x||'').trim();
  const steps=[];
  if(has(variant)&&has(material)&&has(color))steps.push(['Modelo + variante + material + color',r=>sameVar(r.variant,variant)&&same(r.material,material)&&same(r.color,color)]);
  if(has(variant)&&has(color))steps.push(['Modelo + variante + color',r=>sameVar(r.variant,variant)&&same(r.color,color)]);
  if(has(variant)&&has(material))steps.push(['Modelo + variante + material',r=>sameVar(r.variant,variant)&&same(r.material,material)]);
  if(has(variant))steps.push(['Modelo + variante',r=>sameVar(r.variant,variant)]);
  if(has(color))steps.push(['Modelo + color',r=>same(r.color,color)]);
  if(has(material))steps.push(['Modelo + material',r=>same(r.material,material)]);
  steps.push(['Modelo',()=>true]);
  for(const [lvl,test] of steps){
    const r=pick(lvl,test);
    if(r)return {ref:r.ref,n:r.n,level:r.level,row:r};
  }
  const total=cands.find(r=>r.level==='Modelo');
  return total?{ref:total.ref,n:total.n,level:total.level,row:total,weak:true}:null;
}

// Precio de compra más alto con el que, vendiendo a `resale`, el beneficio limpio es al menos marginPct % del coste puesto
// (coste = landedFn(precio)). Misma definición del bot: limpio = venta × (1 − comisión) − coste; margen = limpio / coste.
export function priceForMargin({resale,feePct=20,marginPct=30,landedFn}){
  const r=Number(resale);
  if(!(r>0)||typeof landedFn!=='function')return null;
  const need=p=>r*(1-feePct/100)-landedFn(p)*(1+marginPct/100);   // ≥ 0 cumple el margen
  if(!(need(1)>=0))return null;
  let lo=1,hi=r;
  for(let i=0;i<40;i++){const m=(lo+hi)/2;if(need(m)>=0)lo=m;else hi=m;}
  return Math.floor(lo/5)*5||Math.floor(lo);
}
