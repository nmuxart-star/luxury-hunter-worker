// Convierte las capturas de Vestiaire transcritas (data/vestiaire-refs/*.txt)
// en data/vestiaire-refs.json: anuncios + resumen de precios por tarea.
// El bot usa ese resumen como referencia de reventa en Vestiaire.
// Uso: node scripts/vestiaire-refs-build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir=path.join(root,'data','vestiaire-refs');
const TYPES={
  B:['Bolso City de Cuero','main'],BC:['Bolso City','main'],
  BA:['Bandolera City de Cuero','crossbody'],BAC:['Bandolera City','crossbody'],
  CA:['Cabas City de Cuero','tote'],CAC:['Cabas City','tote'],
  L:['Bolso City de Lino','other_material'],LO:['Bolso City de Lona','other_material'],LA:['Bolso City de Lana','other_material'],
  MO:['Bolso City de Cordero de Mongolia','other_material'],
  M:['Mini bolso City de Cuero','mini'],CT:['Cartera City de Cuero','other'],
  BO:['Bolso boston City de Cuero','other']
};
const GROUP_LABEL={main:'Bolso (tamaño estándar/variado, piel)',crossbody:'Bandolera',tote:'Cabas',mini:'Mini',other_material:'Otros materiales',other:'Otros formatos'};
const pct=(a,p)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);const i=(s.length-1)*p;const lo=Math.floor(i),hi=Math.ceil(i);return Math.round(s[lo]+(s[hi]-s[lo])*(i-lo));};
const stats=a=>({n:a.length,min:a.length?Math.min(...a):null,p25:pct(a,.25),median:pct(a,.5),p75:pct(a,.75),max:a.length?Math.max(...a):null});

const out={built_at:new Date().toISOString(),tasks:{}};
for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.txt')&&!f.endsWith('.fichas.txt')).sort()){
  const text=fs.readFileSync(path.join(dir,f),'utf8');
  const task=(text.match(/^# task:\s*(.+)$/m)||[])[1]?.trim();
  const captured=(text.match(/(\d{2})-(\d{2})-(\d{4})/)||[]);
  if(!task){console.log(`Sin "# task:" en ${f}, lo salto`);continue;}
  const items=[];
  for(const line of text.split('\n')){
    if(!/^\d/.test(line))continue;
    const [screen,type,before,price,country,tags='']=line.split('|');
    const t=TYPES[type];
    if(!t||!Number(price)){console.log(`Línea rara en ${f}: ${line}`);continue;}
    items.push({screen,title:t[0],group:t[1],price_eur:Number(price),
      original_eur:before?Number(before):null,country,vintage:tags.includes('v'),
      we_love:tags.includes('w'),excluded:tags.includes('x')});
  }
  const valid=items.filter(i=>!i.excluded);
  const groups={};
  for(const g of Object.keys(GROUP_LABEL)){
    const prices=valid.filter(i=>i.group===g).map(i=>i.price_eur);
    if(prices.length)groups[g]={label:GROUP_LABEL[g],...stats(prices)};
  }
  out.tasks[task]={
    source:'Capturas de búsqueda en Vestiaire hechas por Nil (precios pedidos, no vendidos)',
    captured_on:captured.length?`${captured[3]}-${captured[2]}-${captured[1]}`:null,
    all:stats(valid.map(i=>i.price_eur)),
    vintage:stats(valid.filter(i=>i.vintage).map(i=>i.price_eur)),
    discounted_share:valid.length?Math.round(100*valid.filter(i=>i.original_eur).length/valid.length):0,
    groups,items
  };
  console.log(`${task}: ${valid.length} anuncios válidos (${items.length-valid.length} descartados), mediana ${out.tasks[task].all.median} €`);
}
// Fichas individuales (con enlace): comparables reales para la IA.
const slug=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/\s+/)[0];
const MATERIAL_SLUG={piel:'cuero',ante:'ante',lona:'lona',lino:'lino'};
for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.fichas.txt')).sort()){
  const text=fs.readFileSync(path.join(dir,f),'utf8');
  const task=(text.match(/^# task:\s*(.+)$/m)||[])[1]?.trim();
  if(!task)continue;
  const fichas=[];
  for(const line of text.split('\n')){
    if(!/^\d/.test(line))continue;
    const [id,size,dims,material,color,condition,price,before,country,tags='',published,notes='']=line.split('|');
    if(!Number(price)){console.log(`Ficha rara en ${f}: ${line}`);continue;}
    fichas.push({id,size,dims,material,color,condition,price_eur:Number(price),original_eur:before?Number(before):null,
      country,vintage:tags.includes('v'),we_love:tags.includes('w'),excluded:tags.includes('x'),published,notes,
      url:`https://es.vestiairecollective.com/mujer-bolsos/bolsos-de-mano/balenciaga/bolsos-de-mano-city-balenciaga-de-${MATERIAL_SLUG[slug(material)]||slug(material)}-${slug(color)}-${id}.shtml`});
  }
  out.tasks[task]=out.tasks[task]||{all:{n:0},groups:{}};
  out.tasks[task].fichas=fichas;
  console.log(`${task}: ${fichas.length} fichas con enlace`);
}
fs.writeFileSync(path.join(root,'data','vestiaire-refs.json'),JSON.stringify(out,null,1)+'\n');
console.log('OK data/vestiaire-refs.json');
