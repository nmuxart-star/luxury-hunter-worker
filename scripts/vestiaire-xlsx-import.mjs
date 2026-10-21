// Lee el Excel de referencias de Vestiaire (el que edita Nil) y lo mete en
// data/vestiaire-refs.json, que es lo que usa el bot. Así el bot compara
// contra lo que hay en el Excel, además de lo que encuentra por internet.
// Hojas: Fichas (todas las tareas con marca), Fendi Baguette y Balenciaga fotos.
// Uso: node scripts/vestiaire-xlsx-import.mjs "/ruta/Vestiaire - Balenciaga Le City.xlsx"
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file=process.argv[2];
if(!file||!fs.existsSync(file)){console.error('Falta el .xlsx');process.exit(1);}
const refsPath=path.join(root,'data','vestiaire-refs.json');
const refs=fs.existsSync(refsPath)?JSON.parse(fs.readFileSync(refsPath,'utf8')):{tasks:{}};
refs.tasks=refs.tasks||{};

const unzip=p=>execFileSync('unzip',['-p',file,p],{encoding:'utf8',maxBuffer:64*1024*1024});
const dec=s=>String(s??'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const colIdx=c=>[...c].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0)-1;

// Hojas → nombre y relaciones
const wb=unzip('xl/workbook.xml');
const rels=unzip('xl/_rels/workbook.xml.rels');
const relTarget=new Map([...rels.matchAll(/<[^:>\s]*:?Relationship\b[^>]*>/g)].map(m=>{
  const id=(m[0].match(/Id="([^"]+)"/)||[])[1];const t=(m[0].match(/Target="([^"]+)"/)||[])[1];return [id,t.replace(/^\/?/,'').replace(/^(?!xl\/)/,'xl/')];}));
const sheets=[...wb.matchAll(/<[^:>\s]*:?sheet\b[^>]*>/g)].map(m=>({
  name:dec((m[0].match(/name="([^"]+)"/)||[])[1]),rid:(m[0].match(/r:id="([^"]+)"/)||[])[1]}));
let sst=[];
try{sst=[...unzip('xl/sharedStrings.xml').matchAll(/<[^:>\s]*:?si>([\s\S]*?)<\/[^:>\s]*:?si>/g)].map(m=>dec([...m[1].matchAll(/<[^:>\s]*:?t[^>]*>([\s\S]*?)<\/[^:>\s]*:?t>/g)].map(x=>x[1]).join('')));}catch{}

function readSheet(target){
  const xml=unzip(target);
  const rows=[];
  for(const rm of xml.matchAll(/<[^:>\s]*:?row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/[^:>\s]*:?row>/g)){
    const r=Number(rm[1]);const o={};
    for(const cm of rm[2].matchAll(/<[^:>\s]*:?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/[^:>\s]*:?c>)/g)){
      const attrs=cm[1],inner=cm[2]||'';
      const ref=(attrs.match(/r="([A-Z]+)\d+"/)||[])[1];if(!ref)continue;
      const t=(attrs.match(/t="([^"]+)"/)||[])[1];
      const v=(inner.match(/<[^:>\s]*:?v>([\s\S]*?)<\/[^:>\s]*:?v>/)||[])[1];
      const is=[...inner.matchAll(/<[^:>\s]*:?t[^>]*>([\s\S]*?)<\/[^:>\s]*:?t>/g)].map(x=>x[1]).join('');
      let val='';
      if(t==='s'&&v!==undefined)val=sst[Number(v)]??'';
      else if(t==='inlineStr')val=dec(is);
      else if(v!==undefined)val=dec(v);
      // Hipervínculos guardados como fórmula o texto: nos quedamos con la URL.
      if(/linkLocation=/.test(val)){const u=val.match(/https?:\/\/[^,\s"]+/);val=u?u[0]:'';}
      o[ref]=val;
    }
    rows[r]=o;
  }
  return rows;
}
const data=Object.fromEntries(sheets.map(s=>[s.name,readSheet(relTarget.get(s.rid))]));

const num=v=>{const n=Number(String(v).replace(',','.'));return Number.isFinite(n)&&String(v).trim()!==''?n:null;};
const dateOnly=v=>String(v||'').slice(0,10);
const sizeFromTipo=t=>String(t||'').trim();

// Cada hoja → lista de fichas con su tarea
function fichasFrom(sheetName,task,map){
  const rows=data[sheetName]||[];
  const head=rows[1]||{};
  const out=[];
  for(const row of rows.slice(2)){
    if(!row)continue;
    const g=k=>map(row,k);
    const id=String(g('ref')||'').trim();
    if(!/^\d{6,}$/.test(id))continue;
    const price=num(g('price'));if(price===null)continue;
    out.push({
      brand:String(g('brand')||'').trim()||task.split(' ')[0],
      id,
      size:sizeFromTipo(g('size')),
      dims:String(g('dims')||'').trim(),
      material:String(g('material')||'').trim(),
      color:String(g('color')||'').trim(),
      condition:String(g('condition')||'').trim(),
      price_eur:price,
      original_eur:num(g('before')),
      country:String(g('country')||'').trim(),
      vintage:/^s[ií]$/i.test(String(g('vintage')||'').trim()),
      we_love:/^s[ií]$/i.test(String(g('welove')||'').trim()),
      excluded:/^s[ií]$/i.test(String(g('excluded')||'').trim()),
      published:dateOnly(g('published')),
      likes:num(g('likes')),
      notes:String(g('notes')||'').trim(),
      url:String(g('url')||'').trim()
    });
  }
  return out;
}
// Mapeo de columnas por cabecera (letra según el nombre de la columna)
function mapperFor(sheetName){
  const head=(data[sheetName]||[])[1]||{};
  const col=name=>Object.keys(head).find(k=>String(head[k]).trim().toLowerCase()===name.toLowerCase());
  const by=names=>{for(const n of names){const c=col(n);if(c)return c;}return null;};
  const C={
    ref:by(['Referencia']),size:by(['Talla','Talla / tipo','Tipo / talla']),dims:by(['Medidas (cm)']),
    material:by(['Material']),color:by(['Color']),condition:by(['Estado']),price:by(['Precio €']),
    before:by(['Precio antes €','Antes €']),country:by(['País']),vintage:by(['Vintage']),welove:by(['We Love']),
    excluded:by(['No es un City']),published:by(['Publicado']),likes:by(['Likes']),notes:by(['Notas']),
    url:by(['Enlace','Anuncio']),brand:by(['Marca'])
  };
  return (row,k)=>C[k]?row[C[k]]:undefined;
}

const summary=[];
// Fichas: todas las tareas en una sola hoja (la columna Marca dice cuál es)
if(data['Fichas']){
  const all=fichasFrom('Fichas','Balenciaga Le City',mapperFor('Fichas'));
  // Cada ficha de la hoja Fichas va a la tarea según su marca/modelo
  const byTask=new Map();
  for(const f of all){
    const task=f.brand==='Balenciaga'?'Balenciaga Le City':null;
    if(!task)continue;
    if(!byTask.has(task))byTask.set(task,[]);byTask.get(task).push(f);
  }
  for(const [task,list] of byTask)summary.push([task,list]);
}
if(data['Fendi Baguette']){
  summary.push(['Fendi Baguette',fichasFrom('Fendi Baguette','Fendi Baguette',mapperFor('Fendi Baguette'))]);
}
// La hoja de fotos de Balenciaga aporta fichas nuevas (sin tocar las que ya están)
if(data['Balenciaga fotos']){
  summary.push(['Balenciaga Le City',fichasFrom('Balenciaga fotos','Balenciaga Le City',mapperFor('Balenciaga fotos'))]);
}

for(const [task,list] of summary){
  const t=refs.tasks[task]||(refs.tasks[task]={all:{n:0},groups:{}});
  const byId=new Map((t.fichas||[]).map(f=>[f.id,f]));
  let added=0,updated=0;
  for(const f of list){
    const prev=byId.get(f.id);
    if(prev){
      // El Excel manda, pero sin borrar datos que el Excel no trae (p. ej. herrajes de capturas antiguas)
      Object.assign(prev,Object.fromEntries(Object.entries(f).filter(([,v])=>v!==''&&v!==null)));updated++;
    }else{byId.set(f.id,f);added++;}
  }
  t.fichas=[...byId.values()].sort((a,b)=>(b.likes||0)-(a.likes||0)||String(b.published).localeCompare(String(a.published)));
  summary.push&&console.log(`${task}: ${added} nuevas, ${updated} actualizadas, ${t.fichas.filter(x=>!x.excluded).length} válidas`);
}
refs.built_at=new Date().toISOString();
refs.source_xlsx=path.basename(file);
fs.writeFileSync(refsPath,JSON.stringify(refs,null,1)+'\n');
console.log('OK data/vestiaire-refs.json');
