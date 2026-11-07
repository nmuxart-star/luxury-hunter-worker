// Enrich the existing "Descripción IA" cells from the photo and listing data.
// Run from GitHub Actions, where OPENAI_API_KEY and GOOGLE_SHEETS_SA_JSON live.
// The script is resumable: a note on each processed description stores the photo
// fingerprint and measured cost. It never adds rows or columns.
import {createHash, createSign} from 'node:crypto';

const SHEET_ID=process.env.VESTIAIRE_SHEET_ID;
const OPENAI_KEY=process.env.OPENAI_API_KEY;
const SA_JSON=process.env.GOOGLE_SHEETS_SA_JSON;
const MODEL=process.env.VESTIAIRE_VISION_MODEL||'gpt-6-luna';
const MODE=process.env.VESTIAIRE_VISION_MODE||'incremental';
const MAX_ROWS=Number(process.env.VESTIAIRE_VISION_MAX_ROWS||0);
const SAMPLE_PER_TAB=Number(process.env.VESTIAIRE_VISION_SAMPLE_PER_TAB||0);
const MAX_SPEND=Number(process.env.VESTIAIRE_VISION_MAX_SPEND_USD||0.5);
const MONTHLY_CAP=Number(process.env.VESTIAIRE_VISION_MONTHLY_CAP_USD||0.5);
const MARK='visual-bag-v1';
const SKIP_TABS=/^(?:Omega |Cartier |Tudor$|Grand Seiko$|TAG Heuer |Rolex |Breitling |IWC |Panerai |Hermès relojes$)/i;
const SPECIFIC_MATERIAL=/\b(?:cordero|caviar|charol|ante|nailon|nylon|lona|lana|seda|sat[eé]n|terciopelo|tweed|denim|algod[oó]n|pit[oó]n|cocodrilo|vis[oó]n|taurillon|becerro|ternera|pana|poliamida|vinilo|shearling|piel de potro|cuero granulado|piel lisa|lino|cachemira|piel vegana|pelo sint[eé]tico)\b/i;
const FIELDS=['variant','material','material_evidence','pattern','shape','hardware','closure','strap'];

function assertEnv(){
  if(!SHEET_ID||!OPENAI_KEY||!SA_JSON)throw new Error('Missing VESTIAIRE_SHEET_ID, OPENAI_API_KEY or GOOGLE_SHEETS_SA_JSON');
  if(MODEL!=='gpt-6-luna')throw new Error('Only gpt-6-luna has a configured cost cap; update rates before changing model');
  if(!['backfill','incremental'].includes(MODE))throw new Error('VESTIAIRE_VISION_MODE must be backfill or incremental');
  if(!(MAX_SPEND>0))throw new Error('VESTIAIRE_VISION_MAX_SPEND_USD must be positive');
  if(!Number.isInteger(MAX_ROWS)||MAX_ROWS<0)throw new Error('VESTIAIRE_VISION_MAX_ROWS must be a nonnegative integer');
  if(!Number.isInteger(SAMPLE_PER_TAB)||SAMPLE_PER_TAB<0)throw new Error('VESTIAIRE_VISION_SAMPLE_PER_TAB must be a nonnegative integer');
}
function quoteTab(s){return `'${s.replaceAll("'","''")}'`;}
function md5(s){return createHash('sha256').update(s).digest('hex').slice(0,16);}
function timeoutFetch(url,opts={}){return fetch(url,{...opts,signal:AbortSignal.timeout(30000)});}
async function readJson(url,opts={}){
  for(let attempt=0;attempt<3;attempt++){
    const r=await timeoutFetch(url,opts);
    const body=await r.json().catch(()=>({}));
    if(r.ok)return body;
    if(attempt<2&&(r.status===429||r.status>=500)){await new Promise(resolve=>setTimeout(resolve,1500*2**attempt));continue;}
    throw new Error(`${r.status} ${JSON.stringify(body.error||body).slice(0,300)}`);
  }
}
async function googleToken(){
  const sa=JSON.parse(SA_JSON),now=Math.floor(Date.now()/1000);
  const b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const unsigned=`${b64({alg:'RS256',typ:'JWT'})}.${b64({iss:sa.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
  const sig=createSign('RSA-SHA256').update(unsigned).sign(sa.private_key,'base64url');
  const j=await readJson('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${unsigned}.${sig}`})});
  return {value:j.access_token,expires:Date.now()+Number(j.expires_in||3600)*1000};
}
let token;
async function google(url,opts={}){
  if(!token||token.expires<Date.now()+60_000)token=await googleToken();
  return readJson(url,{...opts,headers:{authorization:`Bearer ${token.value}`,...opts.headers}});
}
function sheets(path){return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}${path}`;}
async function values(tab,range,render='FORMATTED_VALUE'){
  const a1=`${quoteTab(tab)}!${range}`;
  return (await google(sheets(`/values/${encodeURIComponent(a1)}?valueRenderOption=${render}`))).values||[];
}
async function notes(tab,last){
  const range=`${quoteTab(tab)}!Y2:Y${last}`;
  const q=new URLSearchParams({ranges:range,includeGridData:'true',fields:'sheets(data(startRow,rowData(values(note))))'});
  const j=await google(sheets(`?${q}`));
  const out=Array(last-1).fill('');
  for(const sheet of j.sheets||[])for(const data of sheet.data||[]){
    const start=data.startRow||0;
    for(let i=0;i<(data.rowData||[]).length;i++)if(start+i>=1&&start+i<last)out[start+i-1]=data.rowData[i]?.values?.[0]?.note||'';
  }
  return out;
}
function photoUrl(formula){return String(formula||'').match(/^=IMAGE\("(https?:\/\/[^" ]+)"/i)?.[1]||'';}
async function imageDataUrl(url){
  const r=await timeoutFetch(url,{headers:{'user-agent':'LuxuryHunter/1.0'}});
  if(!r.ok)throw new Error(`image HTTP ${r.status}`);
  const contentType=(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(!['image/jpeg','image/png','image/webp'].includes(contentType))throw new Error(`not an image: ${contentType}`);
  const bytes=Buffer.from(await r.arrayBuffer());
  if(bytes.length<500||bytes.length>4_000_000)throw new Error(`image size ${bytes.length}`);
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}
const schema={type:'object',additionalProperties:false,properties:Object.fromEntries(FIELDS.map(k=>[k,{type:'string'}])),required:FIELDS};
const SYSTEM=`Describe un bolso de segunda mano para comparar referencias de reventa. Usa solo la ficha suministrada y lo que SE VE en esta foto. Devuelve palabras breves en español; cadena vacía si hay duda. Nunca deduzcas Double Flap o Single Flap de una foto exterior cerrada, ni la especie de piel por su aspecto liso. Si se distingue claramente el grano caviar o el brillo de charol, puedes indicarlo. No atribuyas caja, tarjeta, funda ni autenticidad solo porque aparezcan en la foto. No conviertas marcas o rasgos habituales del modelo en pruebas de esta unidad. "material_evidence" debe ser "texto", "visual claro" o vacío. Para herrajes indica solo un color inequívoco; para cierre, solo un mecanismo visible. Conserva tamaño y medidas de la ficha: no los calcules con la foto.`;
async function describe(row,dataUrl){
  const body={model:MODEL,reasoning:{effort:'none'},max_output_tokens:230,
    input:[{role:'system',content:[{type:'input_text',text:SYSTEM}]},{role:'user',content:[
      {type:'input_text',text:JSON.stringify({brand:row.brand,type:row.type,dimensions:row.dimensions,material_column:row.material,color:row.color,notes:row.notes,current_description:row.description})},
      {type:'input_image',image_url:dataUrl,detail:'high'}]}],
    text:{format:{type:'json_schema',name:'bag_features',strict:true,schema}}};
  const j=await readJson('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:`Bearer ${OPENAI_KEY}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const raw=(j.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
  if(!raw)throw new Error(`OpenAI returned no text (${j.status||'unknown status'})`);
  return {features:JSON.parse(raw),usage:j.usage||{}};
}
function cost(usage){return ((usage.input_tokens||0)*0.10+(usage.output_tokens||0)*0.50)/1_000_000;}
function clean(s){return String(s||'').replace(/[·\n\r]/g,' ').replace(/\s+/g,' ').trim().slice(0,75);}
function safeFeature(x){return clean(x).replace(/^(?:desconocid[ao]|no se aprecia|no visible|sin confirmar)$/i,'');}
function enrich(row,raw){
  const f=Object.fromEntries(FIELDS.map(k=>[k,safeFeature(raw?.[k])]));
  let parts=row.description.split(' · ').filter(Boolean);
  if(!parts.length)return row.description;
  // A visible outer flap cannot establish the internal Single/Double Flap version.
  if(/\b(?:double|single) flap\b/i.test(f.variant)&&!new RegExp(f.variant.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(`${row.type} ${row.notes}`))f.variant='';
  if(f.variant&&!parts.slice(0,2).join(' ').toLowerCase().includes(f.variant.toLowerCase())&&new RegExp(f.variant.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(`${row.type} ${row.notes}`))parts[0]+=` ${f.variant}`;
  let material=f.material;
  if(material&&!SPECIFIC_MATERIAL.test(material))material='';
  if(material){
    const inText=new RegExp(material.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(`${row.material} ${row.notes}`);
    const visuallyClear=/^(?:charol|piel caviar|caviar|ante|lona|nailon|denim|terciopelo|lentejuelas)$/i.test(material)&&f.material_evidence==='visual claro';
    if(!inText&&!visuallyClear)material='';
  }
  if(material){const i=parts.findIndex(p=>p==='cuero (tipo sin confirmar)');if(i>=0)parts[i]=material;else if(!parts.some(p=>p.toLowerCase()===material.toLowerCase())&&!SPECIFIC_MATERIAL.test(parts.join(' '))){const j=parts.findIndex(p=>/ cm$/.test(p));parts.splice(j>=0?j+1:1,0,material);}}
  function insert(value,exists,after,before){
    if(!value||exists.test(parts.join(' · ')))return;
    const b=parts.findIndex(p=>before.test(p));
    if(b>=0){parts.splice(b,0,value);return;}
    const a=parts.findLastIndex(p=>after.test(p));
    parts.splice(a>=0?a+1:parts.length,0,value);
  }
  if(/^cannage$/i.test(f.pattern))f.pattern='acolchado Cannage';
  insert(f.pattern,/(?:acolchado|cannage|monograma|motivo|estampado|intrecciato)/i,/(?:cuero|piel|charol|lona|lana|ante|nailon|cm$)/i,/^(?:negro|blanco|azul|beige|rojo|gris|marr[oó]n|burdeos|verde|rosa|naranja|amarillo|dorado|plateado|multicolor)/i);
  insert(f.shape,/(?:formato|silueta|hobo|tote|cabas|bandolera|clutch)/i,/(?:cm$|material|cannage|acolchado|motivo|monograma)/i,/^(?:negro|blanco|azul|beige|rojo|gris|marr[oó]n|burdeos|verde|rosa|naranja|amarillo|dorado|plateado|multicolor)/i);
  if(f.hardware&&!/\bherrajes\b/i.test(f.hardware))f.hardware=`herrajes ${f.hardware}`;
  if(f.closure&&!/\bcierre\b/i.test(f.closure))f.closure=`cierre ${f.closure}`;
  insert(f.hardware,/\bherrajes\b/i,/^(?:negro|blanco|azul|beige|rojo|gris|marr[oó]n|burdeos|verde|rosa|naranja|amarillo|dorado|plateado|multicolor)/i,/^(?:cierre|correa|cadena|bandolera|con )/i);
  insert(f.closure,/\bcierre\b/i,/\bherrajes\b|^(?:negro|blanco|azul|beige|rojo|gris|marr[oó]n|burdeos|verde|rosa|naranja|amarillo|dorado|plateado|multicolor)/i,/^(?:correa|cadena|bandolera|con )/i);
  insert(f.strap,/\b(?:correa|cadena|bandolera|asa)\b/i,/\bcierre\b|\bherrajes\b|^(?:negro|blanco|azul|beige|rojo|gris|marr[oó]n|burdeos|verde|rosa|naranja|amarillo|dorado|plateado|multicolor)/i,/^con /i);
  return parts.join(' · ');
}
function rowFrom(source,description){return {brand:String(source[0]||''),type:String(source[3]||''),dimensions:String(source[4]||''),material:String(source[5]||''),color:String(source[6]||''),notes:String(source[15]||'').slice(0,350),description};}
async function writeRows(sheetId,items){
  if(!items.length)return;
  // Preserve concurrent manual edits to Y.
  const first=Math.min(...items.map(x=>x.row)),last=Math.max(...items.map(x=>x.row));
  const current=await values(items[0].tab,`Y${first}:Y${last}`);
  const requests=[];
  for(const item of items){
    const now=current[item.row-first]?.[0]||'';
    if(now!==item.before){console.log(`Skip concurrent edit ${item.tab}!Y${item.row}`);continue;}
    requests.push({updateCells:{range:{sheetId,startRowIndex:item.row-1,endRowIndex:item.row,startColumnIndex:24,endColumnIndex:25},rows:[{values:[{userEnteredValue:{stringValue:item.after},note:item.note}]}],fields:'userEnteredValue,note'}});
  }
  if(requests.length)await google(sheets(':batchUpdate'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requests})});
  console.log(`Wrote ${requests.length} descriptions`);
}
async function main(){
  assertEnv();
  const meta=await google(sheets('?fields=sheets.properties(sheetId,title,gridProperties(rowCount))'));
  const tabs=(meta.sheets||[]).map(x=>x.properties).filter(x=>x.title&&!SKIP_TABS.test(x.title));
  let spent=0,done=0,failed=0,monthly=0;
  for(const tab of tabs){
    const name=tab.title;
    const [photos,data,descs]=await Promise.all([values(name,`A1:A${tab.gridProperties.rowCount}`,'FORMULA'),values(name,`B1:Q${tab.gridProperties.rowCount}`),values(name,`Y1:Y${tab.gridProperties.rowCount}`)]);
    const last=data.length,marks=await notes(name,last);
    const month=new Date().toISOString().slice(0,7);
    monthly+=marks.reduce((sum,n)=>{const m=n.match(new RegExp(`${MARK}\\|${month}[^\\n]*\\|usd=([0-9.]+)\\|mode=incremental`));return sum+(m?Number(m[1]):0);},0);
    const writes=[];
    let tabDone=0;
    for(let i=1;i<last;i++){
      if(MAX_ROWS&&done>=MAX_ROWS)break;
      if(SAMPLE_PER_TAB&&tabDone>=SAMPLE_PER_TAB)break;
      if(spent>=MAX_SPEND||MODE==='incremental'&&monthly+spent>=MONTHLY_CAP)break;
      const photo=photoUrl(photos[i]?.[0]),before=String(descs[i]?.[0]||'').trim();
      if(!photo||!before)continue;
      const fingerprint=md5(photo),oldNote=marks[i-1]||'';
      if(oldNote.includes(`${MARK}|`)&&oldNote.includes(`photo=${fingerprint}`))continue;
      const row=rowFrom(data[i]||[],before);
      try{
        const image=await imageDataUrl(photo);
        const {features,usage}=await describe(row,image);
        const usd=cost(usage);spent+=usd;done++;tabDone++;
        const after=enrich(row,features);
        const marker=`${MARK}|${new Date().toISOString().slice(0,10)}|photo=${fingerprint}|usd=${usd.toFixed(6)}|mode=${MODE}`;
        writes.push({tab:name,row:i+1,before,after,note:[oldNote.replace(new RegExp(`(?:^|\\n)${MARK}[^\\n]*`,'g'),'').trim(),marker].filter(Boolean).join('\n')});
      }catch(e){failed++;console.error(`${name}!Y${i+1}: ${e.message}`);}
      if(writes.length>=50){await writeRows(tab.sheetId,writes);writes.length=0;console.log(`${name}: ${done} rows, ~$${spent.toFixed(4)}`);}
    }
    await writeRows(tab.sheetId,writes);
    if(MAX_ROWS&&done>=MAX_ROWS||spent>=MAX_SPEND||MODE==='incremental'&&monthly+spent>=MONTHLY_CAP)break;
  }
  console.log(JSON.stringify({done,failed,spent_usd:Number(spent.toFixed(5)),mode:MODE}));
  if(failed)process.exitCode=1;
}

if(import.meta.url===`file://${process.argv[1]}`)main().catch(e=>{console.error(e);process.exitCode=1;});
export {photoUrl,enrich,rowFrom,cost};
