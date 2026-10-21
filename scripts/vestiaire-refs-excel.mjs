// Genera un Excel (.xlsx) por tarea con las referencias de Vestiaire:
// hoja Fichas (anuncios con enlace), hoja Listado (capturas de búsqueda) y Resumen.
// Uso: node scripts/vestiaire-refs-excel.mjs  → data/vestiaire-refs/excel/<tarea>.xlsx
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const refs=JSON.parse(fs.readFileSync(path.join(root,'data','vestiaire-refs.json'),'utf8'));
const outDir=path.join(root,'data','vestiaire-refs','excel');
fs.mkdirSync(outDir,{recursive:true});
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// Textos en tabla compartida (sharedStrings): lo más compatible (Excel, Numbers, Vista Rápida).
let sst=[],sstIdx=new Map();
const si=t=>{t=String(t);if(!sstIdx.has(t)){sstIdx.set(t,sst.length);sst.push(t);}return sstIdx.get(t);};
const col=i=>{let s='';i++;while(i){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26);}return s;};
// Celda: número, texto, {link,text} o {f,v}
function cell(v,r,c,style=0){
  const ref=`${col(c)}${r}`, st=style?` s="${style}"`:'';
  if(v===null||v===undefined||v==='')return `<c r="${ref}"${st}/>`;
  if(typeof v==='number')return `<c r="${ref}"${st}><v>${v}</v></c>`;
  if(typeof v==="object"&&v.link)return `<c r="${ref}" t="str" s="3"><f>HYPERLINK("${esc(v.link)}","${esc(v.text)}")</f><v>${esc(v.text)}</v></c>`;
  return `<c r="${ref}" t="s"${st}><v>${si(v)}</v></c>`;
}
function sheet(header,rows,widths){
  const xmlRows=[`<row r="1">${header.map((h,i)=>cell(h,1,i,1)).join('')}</row>`,
    ...rows.map((row,ri)=>`<row r="${ri+2}">${row.map((v,i)=>cell(v,ri+2,i,typeof v==='number'?2:0)).join('')}</row>`)];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${xmlRows.join('')}</sheetData>${rows.length?`<autoFilter ref="A1:${col(header.length-1)}${rows.length+1}"/>`:''}</worksheet>`;
}
function writeXlsx(file,sheets){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lhx-'));
  const w=(p,s)=>{fs.mkdirSync(path.dirname(path.join(tmp,p)),{recursive:true});fs.writeFileSync(path.join(tmp,p),s);};
  w('[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  w('_rels/.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  w('xl/workbook.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${esc(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets>${sheets.map((s,i)=>s.rows.length?`<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name)}'!$A$1:$${col(s.header.length-1)}$${s.rows.length+1}</definedName></definedNames>`:'').join('').replace(/<\/definedNames><definedNames>/g,'')}</workbook>`);
  w('xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  w('xl/styles.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF111827"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  sst=[];sstIdx=new Map();
  sheets.forEach((s,i)=>w(`xl/worksheets/sheet${i+1}.xml`,sheet(s.header,s.rows,s.widths)));
  w('xl/sharedStrings.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map(t=>`<si><t xml:space="preserve">${esc(t)}</t></si>`).join('')}</sst>`);
  fs.rmSync(file,{force:true});
  execFileSync('zip',['-q','-X','-r',file,'[Content_Types].xml','_rels','xl'],{cwd:tmp});
  fs.rmSync(tmp,{recursive:true,force:true});
}
const yn=b=>b?'Sí':'';
const disc=(p,o)=>o&&o>p?Math.max(1,Math.round(100*(o-p)/o)):'';
for(const [task,t] of Object.entries(refs.tasks)){
  const fichas=(t.fichas||[]).slice().sort((a,b)=>a.size.localeCompare(b.size)||a.price_eur-b.price_eur);
  const sizes={};
  for(const f of fichas.filter(x=>!x.excluded))(sizes[f.size]=sizes[f.size]||[]).push(f.price_eur);
  const med=a=>{const s=[...a].sort((x,y)=>x-y);const m=Math.floor(s.length/2);return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2);};
  const resumen=[
    ...Object.entries(t.groups||{}).map(([,g])=>['Listado (búsqueda)',g.label,g.n,g.min,g.p25,g.median,g.p75,g.max]),
    ...(t.all?.n?[['Listado (búsqueda)','TODOS',t.all.n,t.all.min,t.all.p25,t.all.median,t.all.p75,t.all.max]]:[]),
    ...Object.entries(sizes).map(([s,a])=>['Fichas (con enlace)',s,a.length,Math.min(...a),'',med(a),'',Math.max(...a)])
  ];
  const file=path.join(outDir,`Vestiaire - ${task}.xlsx`);
  writeXlsx(file,[
    {name:'Fichas',header:['Referencia','Talla','Medidas (cm)','Material','Color','Estado','Precio €','Precio antes €','Rebaja %','País','Vintage','We Love','No es un City','Publicado','Notas','Enlace'],
     widths:[12,12,13,10,12,16,10,13,9,12,8,8,12,12,48,14],
     rows:fichas.map(f=>[f.id,f.size,f.dims,f.material,f.color,f.condition,f.price_eur,f.original_eur??'',disc(f.price_eur,f.original_eur),f.country,yn(f.vintage),yn(f.we_love),yn(f.excluded),f.published,f.notes,{link:f.url,text:'Ver anuncio'}])},
    {name:'Listado',header:['Captura','Tipo','Precio €','Precio antes €','Rebaja %','País','Vintage','We Love','Descartado (no es un City)'],
     widths:[9,32,10,13,9,14,8,8,24],
     rows:(t.items||[]).map(i=>[Number(i.screen),i.title,i.price_eur,i.original_eur??'',disc(i.price_eur,i.original_eur),i.country,yn(i.vintage),yn(i.we_love),yn(i.excluded)])},
    {name:'Resumen',header:['Fuente','Grupo / talla','Nº anuncios','Mínimo €','25 % más barato €','Mediana €','75 % €','Máximo €'],
     widths:[20,38,12,10,18,11,9,10],rows:resumen}
  ]);
  console.log(`OK ${file}`);
}
