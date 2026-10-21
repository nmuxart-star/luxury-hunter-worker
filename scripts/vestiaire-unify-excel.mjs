// Une el Excel de Nil en un solo archivo. La hoja "Balenciaga fotos" pasa a ser
// el listado con fotos de Balenciaga City, ordenado por likes y fecha de
// publicación. El resto de hojas (Fichas, Listado, Resumen, Fendi Baguette) no
// se toca. Las fotos salen de la propia hoja "Balenciaga fotos".
// Uso: node scripts/vestiaire-unify-excel.mjs "<Excel de Nil>.xlsx" [salida.xlsx]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src=process.argv[2];
if(!src||!fs.existsSync(src)){console.error('Falta el .xlsx de origen');process.exit(1);}
const out=process.argv[3]||path.join(root,'data','vestiaire-refs','excel','Vestiaire - Balenciaga Le City - unificado.xlsx');
const refs=JSON.parse(fs.readFileSync(path.join(root,'data','vestiaire-refs.json'),'utf8'));
const fichas=(refs.tasks['Balenciaga Le City']?.fichas||[]).filter(f=>!f.excluded);
const byId=new Map(fichas.map(f=>[f.id,f]));

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lh-unify-'));
execFileSync('unzip',['-q','-o',src,'-d',dir]);
const rd=p=>fs.readFileSync(path.join(dir,p),'utf8');
const dec=s=>String(s??'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');

// 1) Localiza la hoja "Balenciaga fotos", su dibujo y las imágenes de cada fila
const wb=rd('xl/workbook.xml');
const rid=(wb.match(/<[^:>\s]*:?sheet\b[^>]*name="Balenciaga fotos"[^>]*r:id="([^"]+)"/)||[])[1];
const relsAll=rd('xl/_rels/workbook.xml.rels');
const rel=id=>{const l=[...relsAll.matchAll(/<[^:>\s]*:?Relationship\b[^>]*>/g)].map(m=>m[0]).find(x=>x.includes(`Id="${id}"`));return (l.match(/Target="([^"]+)"/)||[])[1].replace(/^\/?/,'').replace(/^(?!xl\/)/,'xl/');};
const sheetPath=rel(rid);
const sheetRelsPath=path.join(path.dirname(sheetPath),'_rels',path.basename(sheetPath)+'.rels');
const drawRid=(rd(sheetRelsPath).match(/<[^>]*Relationship\b[^>]*drawing[^>]*>/)||[''])[0].match(/Id="([^"]+)"/)[1];
const drawPath=((rd(sheetRelsPath).match(/Target="([^"]*drawing[^"]*)"/)||[])[1]||'').replace(/^\/?/,'').replace(/^(?!xl\/)/,'xl/');
const drawRelsPath=path.join(path.dirname(drawPath),'_rels',path.basename(drawPath)+'.rels');
const embed=new Map([...rd(drawRelsPath).matchAll(/<[^:>\s]*:?Relationship\b[^>]*>/g)].map(m=>[(m[0].match(/Id="([^"]+)"/)||[])[1],(m[0].match(/Target="([^"]+)"/)||[])[1].replace(/^\/?/,'').replace(/^(?!xl\/)/,'xl/')]));
const sst=[...rd('xl/sharedStrings.xml').matchAll(/<[^:>\s]*:?si>([\s\S]*?)<\/[^:>\s]*:?si>/g)].map(m=>m[1]);
const sstText=i=>dec((sst[i]||'').replace(/<[^>]+>/g,''));
const sheetXml=rd(sheetPath);
const refByRow=new Map();
for(const rm of sheetXml.matchAll(/<[^:>\s]*:?row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/[^:>\s]*:?row>/g)){
  const cm=rm[2].match(/<[^:>\s]*:?c r="B\d+"([^>]*)>([\s\S]*?)<\/[^:>\s]*:?c>/);
  if(!cm)continue;
  const v=(cm[2].match(/<[^:>\s]*:?v>([^<]*)</)||[])[1];
  if(v===undefined)continue;
  refByRow.set(Number(rm[1]),/t="s"/.test(cm[1])?sstText(Number(v)).trim():String(v).trim());
}
const photos=[];   // {ref, media}
for(const am of rd(drawPath).matchAll(/<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/g)){
  const row=Number((am[0].match(/<xdr:row>(\d+)</)||[])[1])+1;
  const rid2=(am[0].match(/r:embed="([^"]+)"/)||[])[1];
  const media=embed.get(rid2);
  const ref=refByRow.get(row);
  if(media&&ref)photos.push({ref,media});
}

// 1b) Fotos recortadas de las capturas de fichas (scripts/tools/vestiaire-crop-photos.py)
const cropDir=path.join(root,'data','vestiaire-refs','photos','balenciaga-le-city');
const crops=fs.existsSync(path.join(cropDir,'index.json'))?JSON.parse(fs.readFileSync(path.join(cropDir,'index.json'),'utf8')):{};
const have=new Set(photos.map(p=>p.ref));
for(const [ref,c] of Object.entries(crops)){
  if(byId.has(ref)&&c.likes!=null&&byId.get(ref).likes==null)byId.get(ref).likes=c.likes;
  if(have.has(ref)||!byId.has(ref))continue;
  const name=`xl/media/vc_${ref}.jpg`;
  fs.copyFileSync(path.join(cropDir,`${ref}.jpg`),path.join(dir,name));
  photos.push({ref,media:name});have.add(ref);
}

// 2) Filas: solo anuncios con foto, ordenados por likes y luego fecha
const withPhoto=photos.filter(p=>byId.has(p.ref)).map(p=>({...byId.get(p.ref),media:p.media}))
  .sort((a,b)=>(b.likes??-1)-(a.likes??-1)||String(b.published).localeCompare(String(a.published)));
const missing=photos.filter(p=>!byId.has(p.ref)).map(p=>p.ref);

// 3) Hoja nueva. Las cadenas se añaden al final de la tabla compartida existente.
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const col=i=>{let s='';i++;while(i){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26);}return s;};
const newStrings=[];const base=sst.length;const idx=new Map();
const si=t=>{t=String(t);if(!idx.has(t)){idx.set(t,base+newStrings.length);newStrings.push(t);}return idx.get(t);};
const header=['Foto','Marca','Likes','Referencia','Talla','Medidas (cm)','Material','Color','Estado','Precio €','Precio antes €','Rebaja %','País','Vintage','We Love','Publicado','Notas','Enlace'];
const widths=[16,14,8,12,12,13,10,12,16,10,13,9,12,8,8,12,48,14];
const ROW_PT=84;
const cell=(v,r,c)=>{
  const ref=`${col(c)}${r}`;
  if(v===null||v===undefined||v==='')return `<x:c r="${ref}"/>`;
  if(typeof v==='number')return `<x:c r="${ref}"><x:v>${v}</x:v></x:c>`;
  if(typeof v==='object'&&v.link)return `<x:c r="${ref}" t="str"><x:f>HYPERLINK("${esc(v.link)}","${esc(v.text)}")</x:f><x:v>${esc(v.text)}</x:v></x:c>`;
  return `<x:c r="${ref}" t="s"><x:v>${si(v)}</x:v></x:c>`;
};
const rowsXml=[`<x:row r="1">${header.map((h,i)=>cell(h,1,i)).join('')}</x:row>`];
withPhoto.forEach((f,ri)=>{
  const r=ri+2;
  const disc=f.original_eur&&f.original_eur>f.price_eur?Math.max(1,Math.round(100*(f.original_eur-f.price_eur)/f.original_eur)):'';
  const vals=['',f.brand||'Balenciaga',f.likes??'',Number(f.id),f.size,f.dims,f.material,f.color,f.condition,f.price_eur,f.original_eur??'',disc,f.country,f.vintage?'Sí':'',f.we_love?'Sí':'',f.published,f.notes,{link:f.url,text:'Ver anuncio'}];
  rowsXml.push(`<x:row r="${r}" ht="${ROW_PT}" customHeight="1">${vals.map((v,i)=>cell(v,r,i)).join('')}</x:row>`);
});
const last=withPhoto.length+1;
const newSheet=`<?xml version="1.0" encoding="utf-8"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheetViews><x:sheetView workbookViewId="0"><x:pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></x:sheetView></x:sheetViews><x:cols>${widths.map((w,i)=>`<x:col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</x:cols><x:sheetData>${rowsXml.join('')}</x:sheetData><x:autoFilter ref="A1:${col(header.length-1)}${last}"/><x:drawing r:id="${drawRid}"/></x:worksheet>`;

// 4) Dibujo: una foto por fila, con las imágenes que ya existían
const drawing=`<?xml version="1.0" encoding="utf-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">${withPhoto.map((f,k)=>`<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>38100</xdr:colOff><xdr:row>${k+1}</xdr:row><xdr:rowOff>38100</xdr:rowOff></xdr:from><xdr:ext cx="1371600" cy="1028700"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${k+2}" name="Foto ${k+1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdImg${k+1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join('')}</xdr:wsDr>`;
const drawingRels=`<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${withPhoto.map((f,k)=>`<Relationship Id="rIdImg${k+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="/${f.media}"/>`).join('')}</Relationships>`;

// 5) Escribe el paquete y empaqueta
fs.writeFileSync(path.join(dir,sheetPath),newSheet);
const ctPath=path.join(dir,'[Content_Types].xml');let ct=fs.readFileSync(ctPath,'utf8');
if(!/Extension="jpg"/i.test(ct))ct=ct.replace(/(<Types[^>]*>)/,'$1<Default Extension="jpg" ContentType="image/jpeg"/>');
fs.writeFileSync(ctPath,ct);
fs.writeFileSync(path.join(dir,drawPath),drawing);
fs.writeFileSync(path.join(dir,drawRelsPath),drawingRels);
const sstAdd=newStrings.map(t=>`<x:si><x:t xml:space="preserve">${esc(t)}</x:t></x:si>`).join('');
const sstOld=rd('xl/sharedStrings.xml');
const sstNew=sstOld.replace(/<\/x:sst>\s*$/,sstAdd+'</x:sst>').replace(/uniqueCount="\d+"/,`uniqueCount="${base+newStrings.length}"`).replace(/ count="\d+"/,` count="${base+newStrings.length}"`);
fs.writeFileSync(path.join(dir,'xl/sharedStrings.xml'),sstNew);
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.rmSync(out,{force:true});
execFileSync('zip',['-q','-X','-r',out,'.'],{cwd:dir});
fs.rmSync(dir,{recursive:true,force:true});
console.log(`OK ${out}`);
console.log(`Hoja "Balenciaga fotos": ${withPhoto.length} anuncios con foto, ordenados por likes y fecha.`);
if(missing.length)console.log(`Fotos sin ficha en los datos (no tocadas): ${missing.join(', ')}`);
