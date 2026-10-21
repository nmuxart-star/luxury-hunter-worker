// Página de Balenciaga City en Excel: un anuncio por fila, con foto, ordenado
// por likes (de mayor a menor) y después por fecha de publicación.
// Las fotos se reutilizan de la hoja "Balenciaga fotos" del Excel de Nil.
// Uso: node scripts/vestiaire-page-excel.mjs "<Excel de Nil>.xlsx" [salida.xlsx]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src=process.argv[2];
const out=process.argv[3]||path.join(root,'data','vestiaire-refs','excel','Vestiaire - Balenciaga Le City - página.xlsx');
const refs=JSON.parse(fs.readFileSync(path.join(root,'data','vestiaire-refs.json'),'utf8'));
const fichas=(refs.tasks['Balenciaga Le City']?.fichas||[]).filter(f=>!f.excluded);

// 1) Fotos ya puestas en la hoja "Balenciaga fotos": fila → referencia → imagen
const photoByRef=new Map();
if(src&&fs.existsSync(src)){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lh-photos-'));
  execFileSync('unzip',['-q','-o',src,'-d',dir]);
  const x=p=>fs.readFileSync(path.join(dir,p),'utf8');
  const wb=x('xl/workbook.xml');
  const rels=x('xl/_rels/workbook.xml.rels');
  const sheetRid=(wb.match(/<[^:>\s]*:?sheet\b[^>]*name="Balenciaga fotos"[^>]*r:id="([^"]+)"/)||[])[1];
  const target=(rels.match(new RegExp(`Id="${sheetRid}"`))||[]);
  const relLine=[...rels.matchAll(/<[^:>\s]*:?Relationship\b[^>]*>/g)].map(m=>m[0]).find(l=>l.includes(`Id="${sheetRid}"`));
  const sheetPath=(relLine.match(/Target="([^"]+)"/)[1]).replace(/^\/?/,'').replace(/^(?!xl\/)/,'xl/');
  const sheetXml=x(sheetPath);
  const sheetName=path.basename(sheetPath);
  const relsPath=path.join(path.dirname(sheetPath),'_rels',`${sheetName}.rels`);
  const drawingTarget=(fs.existsSync(path.join(dir,relsPath))?x(relsPath):'').match(/Target="([^"]*drawing[^"]*)"/);
  if(drawingTarget){
    const dpath=drawingTarget[1].replace(/^\/?/,'').replace(/^(?!xl\/)/,'xl/').replace('xl/../','');
    const dxml=x(dpath);
    const drels=x(path.join(path.dirname(dpath),'_rels',`${path.basename(dpath)}.rels`));
    const embedTarget=new Map([...drels.matchAll(/<[^:>\s]*:?Relationship\b[^>]*>/g)].map(m=>{
      const id=(m[0].match(/Id="([^"]+)"/)||[])[1];const t=(m[0].match(/Target="([^"]+)"/)||[])[1];
      return [id,t.replace(/^\/?/,'').replace(/^(?!xl\/)/,'xl/')];}));
    // fila de cada imagen (0-based en el dibujo → fila Excel = +1)
    const anchors=[...dxml.matchAll(/<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/g)].map(m=>m[0]);
    const rowOfRid=new Map();
    for(const a of anchors){
      const row=Number((a.match(/<xdr:row>(\d+)<\/xdr:row>/)||[])[1]);
      const rid=(a.match(/r:embed="([^"]+)"/)||[])[1];
      if(!isNaN(row)&&rid)rowOfRid.set(row+1,embedTarget.get(rid));
    }
    // fila → referencia (columna B de esa hoja)
    const refByRow=new Map();
    for(const rm of sheetXml.matchAll(/<[^:>\s]*:?row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/[^:>\s]*:?row>/g)){
      const r=Number(rm[1]);
      const cm=rm[2].match(/<[^:>\s]*:?c r="B\d+"[^>]*>([\s\S]*?)<\/[^:>\s]*:?c>/);
      const v=cm&&(cm[1].match(/<[^:>\s]*:?v>([^<]*)</)||[])[1];
      if(v)refByRow.set(r,v.trim());
    }
    const sst=[...x('xl/sharedStrings.xml').matchAll(/<[^:>\s]*:?si>([\s\S]*?)<\/[^:>\s]*:?si>/g)].map(m=>m[1]);
    for(const [row,media] of rowOfRid){
      let ref=refByRow.get(row);
      // la celda B puede ser texto compartido
      if(ref&&/^\d+$/.test(ref)&&sst[Number(ref)]!==undefined&&!/^\d{6,}$/.test(ref)){ref=sst[Number(ref)].replace(/<[^>]+>/g,'');}
      if(!ref)continue;
      const file=path.join(dir,media);
      if(fs.existsSync(file))photoByRef.set(String(ref).trim(),{file:fs.readFileSync(file)});
    }
  }
  fs.rmSync(dir,{recursive:true,force:true});
}

// 2) Orden: likes (mayor a menor) y luego fecha de publicación (más nueva primero)
const sorted=[...fichas].sort((a,b)=>(b.likes??-1)-(a.likes??-1)||String(b.published).localeCompare(String(a.published)));
const header=['Foto','Marca','Likes','Referencia','Talla','Medidas (cm)','Material','Color','Estado','Precio €','Precio antes €','Rebaja %','País','Vintage','We Love','Publicado','Notas','Enlace'];
const widths=[16,14,8,12,12,13,10,12,16,10,13,9,12,8,8,12,48,14];
const ROW_PT=84;
const rows=sorted.map(f=>[
  '', f.brand||'Balenciaga', f.likes??'', f.id, f.size, f.dims, f.material, f.color, f.condition, f.price_eur,
  f.original_eur??'', f.original_eur&&f.original_eur>f.price_eur?Math.max(1,Math.round(100*(f.original_eur-f.price_eur)/f.original_eur)):'',
  f.country, f.vintage?'Sí':'', f.we_love?'Sí':'', f.published, f.notes, {link:f.url,text:'Ver anuncio'}
]);
const withPhoto=rows.map((r,i)=>photoByRef.has(sorted[i].id)?i:null).filter(i=>i!==null);

// 3) Escribir xlsx (con imágenes)
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const col=i=>{let s='';i++;while(i){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26);}return s;};
let sst=[],sstIdx=new Map();
const si=t=>{t=String(t);if(!sstIdx.has(t)){sstIdx.set(t,sst.length);sst.push(t);}return sstIdx.get(t);};
function cell(v,r,c,style=0){
  const ref=`${col(c)}${r}`, st=style?` s="${style}"`:'';
  if(v===null||v===undefined||v==='')return `<c r="${ref}"${st}/>`;
  if(typeof v==='number')return `<c r="${ref}"${st}><v>${v}</v></c>`;
  if(typeof v==='object'&&v.link)return `<c r="${ref}" t="str" s="3"><f>HYPERLINK("${esc(v.link)}","${esc(v.text)}")</f><v>${esc(v.text)}</v></c>`;
  return `<c r="${ref}" t="s"${st}><v>${si(v)}</v></c>`;
}
const sheetXml=()=>{
  const xmlRows=[`<row r="1">${header.map((h,i)=>cell(h,1,i,1)).join('')}</row>`,
    ...rows.map((row,ri)=>{
      const ht=photoByRef.has(sorted[ri].id)?` ht="${ROW_PT}" customHeight="1"`:'';
      return `<row r="${ri+2}"${ht}>${row.map((v,i)=>cell(v,ri+2,i,typeof v==='number'?2:0)).join('')}</row>`;})];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${xmlRows.join('')}</sheetData><autoFilter ref="A1:${col(header.length-1)}${rows.length+1}"/>${withPhoto.length?'<drawing r:id="rId1"/>':''}</worksheet>`;
};
const drawingXml=()=>`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">${withPhoto.map((ri,k)=>`<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>38100</xdr:colOff><xdr:row>${ri+1}</xdr:row><xdr:rowOff>38100</xdr:rowOff></xdr:from><xdr:ext cx="1371600" cy="1028700"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${k+2}" name="Foto ${k+1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdImg${k+1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join('')}</xdr:wsDr>`;
const drawingRels=()=>`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${withPhoto.map((ri,k)=>`<Relationship Id="rIdImg${k+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/foto${k+1}.png"/>`).join('')}</Relationships>`;

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lh-page-'));
const w=(p,s)=>{fs.mkdirSync(path.dirname(path.join(tmp,p)),{recursive:true});fs.writeFileSync(path.join(tmp,p),s);};
const sheetData=sheetXml();
w('[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${withPhoto.length?'<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>':''}</Types>`);
w('_rels/.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
w('xl/workbook.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Balenciaga fotos" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Balenciaga fotos'!$A$1:$${col(header.length-1)}$${rows.length+1}</definedName></definedNames></workbook>`);
w('xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
w('xl/styles.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF111827"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
w('xl/sharedStrings.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map(t=>`<si><t xml:space="preserve">${esc(t)}</t></si>`).join('')}</sst>`);
w('xl/worksheets/sheet1.xml',sheetData);
if(withPhoto.length){
  w('xl/worksheets/_rels/sheet1.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
  w('xl/drawings/drawing1.xml',drawingXml());
  w('xl/drawings/_rels/drawing1.xml.rels',drawingRels());
  withPhoto.forEach((ri,k)=>fs.writeFileSync(path.join(tmp,`xl/media/foto${k+1}.png`),(fs.mkdirSync(path.join(tmp,'xl/media'),{recursive:true}),photoByRef.get(sorted[ri].id).file)));
}
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.rmSync(out,{force:true});
execFileSync('zip',['-q','-X','-r',out,'[Content_Types].xml','_rels','xl'],{cwd:tmp});
fs.rmSync(tmp,{recursive:true,force:true});
console.log(`OK ${out}`);
console.log(`Anuncios: ${rows.length}. Con foto: ${withPhoto.length}. Sin foto (pegar a mano): ${rows.length-withPhoto.length}. Con likes: ${sorted.filter(f=>f.likes!=null).length}.`);
