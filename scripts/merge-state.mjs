// Junta la "memoria" de varias bases de datos de Luxury Hunter en una:
// anuncios, análisis, avisos ya enviados, valoraciones de Telegram y gasto IA.
// Así no se repiten avisos ni se vuelve a pagar análisis ya hechos aunque
// alguna ejecución haya arrancado sin estado.
// Uso: node scripts/merge-state.mjs <destino.sqlite3> <otra1.sqlite3> [otra2...]
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [target,...others]=process.argv.slice(2);
if(!target||!fs.existsSync(target)){console.log('merge-state: falta la base de destino');process.exit(0);}
const db=new DatabaseSync(target);
const cols=(d,t)=>d.prepare(`PRAGMA table_info(${t})`).all().map(c=>c.name);
const hasTable=(d,t)=>!!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const getSetting=(d,k)=>{try{return JSON.parse(d.prepare('SELECT value_json FROM app_settings WHERE key=?').get(k)?.value_json??'null');}catch{return null;}};
const putSetting=(k,v)=>db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(k,JSON.stringify(v),new Date().toISOString());

let stats={listings:0,analyses:0,notifications:0,feedback:0};
let spendToday=Number(getSetting(db,'ai_spend')?.day===today?getSetting(db,'ai_spend').usd:0)||0;
let lastDigest=getSetting(db,'global_digest_state')?.last_sent_at||null;
let tgOffset=Number(getSetting(db,'telegram_update_offset')||0);
const monthNow=new Date().toISOString().slice(0,7);
let month=(getSetting(db,'ai_spend_month')||{});if(month.month!==monthNow)month={month:monthNow,usd:0};

const listingCols=cols(db,'listings').filter(c=>c!=='id');
const analysisCols=hasTable(db,'task_analyses')?cols(db,'task_analyses').filter(c=>!['id','task_id','listing_id'].includes(c)):[];
const taskIdByName=new Map(db.prepare('SELECT id,task_name FROM tasks').all().map(t=>[t.task_name,t.id]));

for(const file of others){
  if(!file||!fs.existsSync(file))continue;
  let src;
  try{src=new DatabaseSync(file,{readOnly:true});}catch{continue;}
  const srcTask=new Map(src.prepare('SELECT id,task_name FROM tasks').all().map(t=>[t.id,t.task_name]));
  const mapTask=id=>id===0?0:taskIdByName.get(srcTask.get(id))??null;
  // Anuncio del origen → id en destino (se crea si no existe).
  const idMap=new Map();
  const mapListing=sid=>{
    if(idMap.has(sid))return idMap.get(sid);
    const l=src.prepare('SELECT * FROM listings WHERE id=?').get(sid);
    if(!l)return null;
    let row=db.prepare('SELECT id FROM listings WHERE source=? AND source_id=?').get(l.source,l.source_id);
    if(!row){
      const use=listingCols.filter(c=>c in l);
      db.prepare(`INSERT INTO listings(${use.join(',')}) VALUES(${use.map(()=>'?').join(',')})`).run(...use.map(c=>l[c]));
      row=db.prepare('SELECT id FROM listings WHERE source=? AND source_id=?').get(l.source,l.source_id);
      stats.listings++;
    }
    idMap.set(sid,row.id);
    return row.id;
  };
  if(hasTable(src,'task_analyses')){
    const srcCols=new Set(cols(src,'task_analyses'));
    const use=analysisCols.filter(c=>srcCols.has(c));
    for(const a of src.prepare('SELECT * FROM task_analyses').all()){
      const t=mapTask(a.task_id), l=mapListing(a.listing_id);
      if(t==null||l==null)continue;
      const r=db.prepare(`INSERT OR IGNORE INTO task_analyses(task_id,listing_id,${use.join(',')}) VALUES(?,?,${use.map(()=>'?').join(',')})`).run(t,l,...use.map(c=>a[c]));
      stats.analyses+=r.changes;
    }
  }
  for(const n of src.prepare('SELECT * FROM notifications').all()){
    const t=mapTask(n.task_id), l=mapListing(n.listing_id);
    if(t==null||l==null)continue;
    const r=db.prepare('INSERT OR IGNORE INTO notifications(task_id,listing_id,run_id,kind,sent_to,sent_at) VALUES(?,?,?,?,?,?)').run(t,l,null,n.kind,n.sent_to,n.sent_at);
    stats.notifications+=r.changes;
  }
  if(hasTable(src,'listing_feedback')&&hasTable(db,'listing_feedback')){
    for(const f of src.prepare('SELECT * FROM listing_feedback').all()){
      const l=mapListing(f.listing_id);
      if(l==null)continue;
      const r=db.prepare('INSERT OR IGNORE INTO listing_feedback(listing_id,action,source,created_at) VALUES(?,?,?,?)').run(l,f.action,f.source,f.created_at);
      stats.feedback+=r.changes;
    }
  }
  // Gasto de hoy: nunca se rebaja (si hace falta ajustarlo a la factura real
  // se usa AI_SPEND_RESET).
  const sp=getSetting(src,'ai_spend');
  if(sp?.day===today)spendToday=Math.max(spendToday,Number(sp.usd||0));
  const dg=getSetting(src,'global_digest_state')?.last_sent_at;
  if(dg&&(!lastDigest||dg>lastDigest))lastDigest=dg;
  tgOffset=Math.max(tgOffset,Number(getSetting(src,'telegram_update_offset')||0));
  const sm=getSetting(src,'ai_spend_month');
  if(sm?.month===monthNow&&Number(sm.usd||0)>Number(month.usd||0))month=sm;
  src.close();
}
const cur=getSetting(db,'ai_spend');
putSetting('ai_spend',{...(cur?.day===today?cur:{day:today,calls:0,webSearches:0,byPurpose:{}}),usd:Number(spendToday.toFixed(4))});
if(lastDigest)putSetting('global_digest_state',{...(getSetting(db,'global_digest_state')||{}),last_sent_at:lastDigest});
if(tgOffset)putSetting('telegram_update_offset',tgOffset);
if(month.usd)putSetting('ai_spend_month',month);
console.log(`merge-state: +${stats.listings} anuncios, +${stats.analyses} análisis, +${stats.notifications} avisos, +${stats.feedback} valoraciones; gasto IA hoy ${spendToday.toFixed(2)} $; último resumen ${lastDigest||'-'}`);
