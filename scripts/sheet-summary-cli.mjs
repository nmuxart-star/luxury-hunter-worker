// Construye (o actualiza) la pestaña «Resumen» de la hoja, en primer lugar. Uso:
//   VESTIAIRE_SHEET_ID=… GOOGLE_SHEETS_SA_FILE=… node scripts/sheet-summary-cli.mjs [--dry]
// --dry: solo calcula y cuenta, no escribe nada. Sin --dry reescribe por completo la pestaña «Resumen» (las demás no se tocan).
import fs from 'node:fs';
import crypto from 'node:crypto';
import {buildSummary,parseTabForSummary,summaryToValues,SUMMARY_TAB,SUMMARY_PARAMS} from './sheet-summary.mjs';
import {isWatchTaskName} from './github-run-schedule.mjs';

const DRY=process.argv.includes('--dry');
const SHEET=String(process.env.VESTIAIRE_SHEET_ID||'').trim();
const KEY=process.env.GOOGLE_SHEETS_SA_FILE||`${process.env.HOME}/luxury-hunter/private/sheets-sa.json`;
if(!SHEET){console.error('Falta VESTIAIRE_SHEET_ID');process.exit(1);}
const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
async function token(write){
  const s=JSON.parse(fs.readFileSync(KEY,'utf8'));const now=Math.floor(Date.now()/1000);
  const scope=write?'https://www.googleapis.com/auth/spreadsheets':'https://www.googleapis.com/auth/spreadsheets.readonly';
  const u=b64({alg:'RS256',typ:'JWT'})+'.'+b64({iss:s.client_email,scope,aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
  const sig=crypto.sign('RSA-SHA256',Buffer.from(u),s.private_key).toString('base64url');
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:u+'.'+sig})});
  const j=await r.json();if(!j.access_token)throw new Error('token: '+JSON.stringify(j).slice(0,200));return j.access_token;
}
const tk=await token(!DRY);
const H={authorization:'Bearer '+tk,'content-type':'application/json'};
const base=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET)}`;
const api=async(url,opt={})=>{const r=await fetch(url,{headers:H,...opt});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`${r.status} ${j?.error?.message||''}`);return j;};

const meta=await api(`${base}?fields=sheets.properties`);
const props=meta.sheets.map(s=>s.properties);
const sources=props.filter(p=>p.title!==SUMMARY_TAB);
const fichas=[];
for(let i=0;i<sources.length;i+=6){                                  // de 6 en 6 por la cuota de lecturas
  const part=sources.slice(i,i+6);
  const q=part.map(p=>'ranges='+encodeURIComponent(`'${p.title.replace(/'/g,"''")}'!A1:AM${p.gridProperties?.rowCount||3000}`)).join('&');
  const j=await api(`${base}/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE`);
  j.valueRanges.forEach((vr,k)=>{
    const p=part[k];
    const got=parseTabForSummary(vr.values||[],p.title,isWatchTaskName(p.title)?'watch':'bag');
    console.log(`  ${p.title.padEnd(36)} ${String(got.length).padStart(5)} fichas`);
    fichas.push(...got);
  });
  if(i+6<sources.length)await new Promise(r=>setTimeout(r,2500));
}
const rows=buildSummary(fichas);
const byLevel={};rows.forEach(r=>byLevel[r.level]=(byLevel[r.level]||0)+1);
console.log(`\n${fichas.length} fichas → ${rows.length} filas de resumen`,byLevel);
if(DRY){console.log('(--dry: no se ha escrito nada)');process.exit(0);}

const stamp=new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',dateStyle:'short',timeStyle:'short'}).format(new Date());
const fx=Number(process.env.FX_CNY_PER_EUR);
const params=SUMMARY_PARAMS.map(([l,v],i)=>i===10&&fx>3&&fx<15?[l,fx]:[l,v]);
const values=summaryToValues(rows,{params,updated:stamp});
let tab=props.find(p=>p.title===SUMMARY_TAB);
if(!tab){
  const r=await api(`${base}:batchUpdate`,{method:'POST',body:JSON.stringify({requests:[{addSheet:{properties:{title:SUMMARY_TAB,index:0,gridProperties:{rowCount:Math.max(values.length+50,200),columnCount:24,frozenRowCount:1}}}}]})});
  tab=r.replies[0].addSheet.properties;
  console.log('Pestaña «Resumen» creada en primer lugar.');
}else{
  await api(`${base}:batchUpdate`,{method:'POST',body:JSON.stringify({requests:[
    {updateSheetProperties:{properties:{sheetId:tab.sheetId,index:0,gridProperties:{rowCount:Math.max(values.length+50,200),columnCount:24,frozenRowCount:1}},fields:'index,gridProperties(rowCount,columnCount,frozenRowCount)'}}]})});
  await api(`${base}/values/${encodeURIComponent(`'${SUMMARY_TAB}'!A1:Z${tab.gridProperties?.rowCount||5000}`)}:clear`,{method:'POST',body:'{}'});
}
const range=`'${SUMMARY_TAB}'!A1`;
for(let i=0;i<values.length;i+=2500){                                // por tandas
  const chunk=values.slice(i,i+2500);
  await api(`${base}/values/${encodeURIComponent(`'${SUMMARY_TAB}'!A${i+1}`)}?valueInputOption=USER_ENTERED`,{method:'PUT',body:JSON.stringify({range:`'${SUMMARY_TAB}'!A${i+1}`,majorDimension:'ROWS',values:chunk})});
}
const sid=tab.sheetId,n=values.length;
const color=(r,g,b)=>({red:r,green:g,blue:b});
const dims=(start,end)=>({sheetId:sid,dimension:'COLUMNS',startIndex:start,endIndex:end});
const widths=[[0,1,70],[1,2,120],[2,3,230],[3,4,170],[4,5,120],[5,6,110],[6,7,150],[7,8,210],[8,10,70],[10,16,110],[16,17,80],[17,18,90],[18,19,150],[19,20,30],[20,21,260],[21,22,90]];
const reqs=[
  {updateSheetProperties:{properties:{sheetId:sid,gridProperties:{frozenRowCount:1}},fields:'gridProperties.frozenRowCount'}},
  {repeatCell:{range:{sheetId:sid,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:19},cell:{userEnteredFormat:{backgroundColor:color(0.12,0.12,0.14),textFormat:{bold:true,foregroundColor:color(1,1,1)},wrapStrategy:'WRAP',verticalAlignment:'MIDDLE'}},fields:'userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment)'}},
  {repeatCell:{range:{sheetId:sid,startRowIndex:1,endRowIndex:n,startColumnIndex:10,endColumnIndex:16},cell:{userEnteredFormat:{numberFormat:{type:'NUMBER',pattern:'#,##0'}}},fields:'userEnteredFormat.numberFormat'}},
  {repeatCell:{range:{sheetId:sid,startRowIndex:1,endRowIndex:n,startColumnIndex:15,endColumnIndex:16},cell:{userEnteredFormat:{textFormat:{bold:true},backgroundColor:color(0.91,0.96,0.91)}},fields:'userEnteredFormat(textFormat,backgroundColor)'}},
  {repeatCell:{range:{sheetId:sid,startRowIndex:1,endRowIndex:n,startColumnIndex:18,endColumnIndex:19},cell:{userEnteredFormat:{numberFormat:{type:'NUMBER',pattern:'#,##0 "€"'},textFormat:{bold:true},backgroundColor:color(0.99,0.95,0.84)}},fields:'userEnteredFormat(numberFormat,textFormat,backgroundColor)'}},
  {repeatCell:{range:{sheetId:sid,startRowIndex:0,endRowIndex:1,startColumnIndex:20,endColumnIndex:22},cell:{userEnteredFormat:{backgroundColor:color(0.12,0.12,0.14),textFormat:{bold:true,foregroundColor:color(1,1,1)}}},fields:'userEnteredFormat(backgroundColor,textFormat)'}},
  {repeatCell:{range:{sheetId:sid,startRowIndex:1,endRowIndex:12,startColumnIndex:21,endColumnIndex:22},cell:{userEnteredFormat:{backgroundColor:color(1,0.97,0.8),textFormat:{bold:true}}},fields:'userEnteredFormat(backgroundColor,textFormat)'}},
  {repeatCell:{range:{sheetId:sid,startRowIndex:1,endRowIndex:6,startColumnIndex:21,endColumnIndex:22},cell:{userEnteredFormat:{numberFormat:{type:'PERCENT',pattern:'0.0%'}}},fields:'userEnteredFormat.numberFormat'}},
  {repeatCell:{range:{sheetId:sid,startRowIndex:6,endRowIndex:8,startColumnIndex:21,endColumnIndex:22},cell:{userEnteredFormat:{numberFormat:{type:'PERCENT',pattern:'0.0%'}}},fields:'userEnteredFormat.numberFormat'}},
  {setBasicFilter:{filter:{range:{sheetId:sid,startRowIndex:0,endRowIndex:n,startColumnIndex:0,endColumnIndex:19}}}},
  ...widths.map(([s,e,px])=>({updateDimensionProperties:{range:dims(s,e),properties:{pixelSize:px},fields:'pixelSize'}})),
  {updateDimensionProperties:{range:{sheetId:sid,dimension:'ROWS',startIndex:0,endIndex:1},properties:{pixelSize:42},fields:'pixelSize'}}
];
await api(`${base}:batchUpdate`,{method:'POST',body:JSON.stringify({requests:reqs})});
console.log(`Pestaña «${SUMMARY_TAB}» escrita: ${rows.length} filas (A1:S${n}) + parámetros en U:V.`);
