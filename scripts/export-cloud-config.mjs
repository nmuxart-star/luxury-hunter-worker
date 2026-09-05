import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbPath=path.join(root,'data','luxury-hunter.sqlite3');
if(!fs.existsSync(dbPath)) throw new Error(`No existe ${dbPath}`);
const db=new DatabaseSync(dbPath,{readOnly:true});
const rows=db.prepare('SELECT * FROM tasks ORDER BY id').all();
const parse=(s,f)=>{try{return JSON.parse(s??'')}catch{return f}};
const tasks=rows.map(r=>({
  task_name:r.task_name,
  enabled:!!r.enabled,
  product_query:r.product_query,
  sources:parse(r.sources_json,[]),
  description:r.description||'',
  analyze_images:!!r.analyze_images,
  max_pages:r.max_pages,
  max_items:r.max_items,
  min_eur:r.min_eur,
  max_eur:r.max_eur,
  personal_only:!!r.personal_only,
  free_shipping:!!r.free_shipping,
  new_publish_option:r.new_publish_option,
  region:r.region,
  cron:r.cron,
  account_state_file:r.account_state_file,
  account_strategy:r.account_strategy||'auto',
  decision_mode:r.decision_mode||'ai',
  keyword_rules:parse(r.keyword_rules_json,[]),
  xianyu_queries:parse(r.xianyu_queries_json,[]),
  bunjang_queries:parse(r.bunjang_queries_json,[]),
  japan_queries:parse(r.japan_queries_json,[]),
  interval_minutes:r.interval_minutes,
  run_if_missed:!!r.run_if_missed,
  email_enabled:!!r.email_enabled,
  email_to:r.email_to,
  notify_decisions:parse(r.notify_decisions_json,['STRONG BUY','BUY']),
  notify_min_score:r.notify_min_score,
  notify_min_profit_eur:r.notify_min_profit_eur,
  notify_max_items:r.notify_max_items||8,
  notify_only_new:!!r.notify_only_new
}));
let economics=null;
const erow=db.prepare("SELECT value_json FROM app_settings WHERE key='economics'").get();
if(erow) economics=parse(erow.value_json,null);
const out={version:1,exported_at:new Date().toISOString(),tasks,economics};
fs.mkdirSync(path.join(root,'cloud'),{recursive:true});
const outPath=path.join(root,'cloud','config.json');
fs.writeFileSync(outPath,JSON.stringify(out,null,2)+'\n');
console.log(`OK cloud config: ${outPath}`);
console.log(`Tasks exported: ${tasks.length}`);
