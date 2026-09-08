import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root=path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);

function arg(name){
  const i=process.argv.indexOf(name);
  return i>=0 ? process.argv[i+1] : null;
}

function run(command,args=[],options={}){
  return execFileSync(command,args,{
    cwd:root,
    encoding:'utf8',
    maxBuffer:20*1024*1024,
    ...options
  });
}

function resolveGh(){
  const candidates=[
    String(process.env.GH_BIN||'').trim(),
    path.join(process.env.HOME||'', 'bin', 'gh'),
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh'
  ].filter(Boolean);

  for(const candidate of candidates){
    if(fs.existsSync(candidate))return candidate;
  }

  return 'gh';
}

function githubRepoSlug(){
  const envRepo=String(
    process.env.GITHUB_REPOSITORY||''
  ).trim();

  if(/^[^/]+\/[^/]+$/.test(envRepo)){
    return envRepo;
  }

  const remote=run(
    'git',
    ['remote','get-url','origin']
  ).trim();

  const match=remote.match(
    /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i
  );

  if(!match){
    throw new Error(
      `No puedo determinar el repositorio GitHub desde origin: ${remote}`
    );
  }

  return match[1].replace(/\.git$/i,'');
}

function findSqlite(dir){
  const direct=path.join(dir,'luxury-hunter.sqlite3');
  if(fs.existsSync(direct))return direct;

  for(const entry of fs.readdirSync(dir,{
    withFileTypes:true
  })){
    const full=path.join(dir,entry.name);

    if(entry.isDirectory()){
      const found=findSqlite(full);
      if(found)return found;
    }else if(
      entry.isFile() &&
      entry.name==='luxury-hunter.sqlite3'
    ){
      return full;
    }
  }

  return null;
}

function downloadLatestCloudDb(){
  if(
    String(process.env.GITHUB_ACTIONS||'')
      .toLowerCase()==='true'
  ){
    throw new Error(
      'La descarga automática cloud no se ejecuta dentro de GitHub Actions.'
    );
  }

  const gh=resolveGh();
  const repo=githubRepoSlug();

  const payload=JSON.parse(
    run(gh,[
      'api',
      `repos/${repo}/actions/artifacts?name=luxury-hunter-state&per_page=50`
    ])
  );

  const artifacts=(payload.artifacts||[])
    .filter(
      a=>!a.expired && a.workflow_run?.id
    )
    .sort(
      (a,b)=>
        String(b.created_at||'')
          .localeCompare(String(a.created_at||''))
    );

  const latest=artifacts[0];

  if(!latest){
    throw new Error(
      `No encuentro un artifact vigente luxury-hunter-state en ${repo}.`
    );
  }

  const tempDir=fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      'luxury-hunter-cloud-state-'
    )
  );

  run(gh,[
    'run',
    'download',
    String(latest.workflow_run.id),
    '--repo',
    repo,
    '-n',
    'luxury-hunter-state',
    '-D',
    tempDir
  ]);

  const downloadedPath=findSqlite(tempDir);

  if(!downloadedPath){
    throw new Error(
      `El artifact ${latest.id} se descargó pero no contiene luxury-hunter.sqlite3.`
    );
  }

  console.log(
    'Cloud artifact descargado automáticamente: '+
    `repo=${repo} artifact=${latest.id} `+
    `run=${latest.workflow_run.id} created=${latest.created_at}`
  );

  return downloadedPath;
}

const localArg=arg('--local-db');
const cloudArg=arg('--cloud-db');

if(!localArg){
  throw new Error(
    'Uso: node scripts/sync-cloud-state.mjs --local-db <local.sqlite3> [--cloud-db <cloud.sqlite3>]'
  );
}

const localPath=path.resolve(localArg);
const cloudPath=cloudArg
  ? path.resolve(cloudArg)
  : downloadLatestCloudDb();

if(localPath===cloudPath){
  throw new Error(
    'La base local y cloud no pueden ser el mismo archivo.'
  );
}

if(!fs.existsSync(localPath)){
  throw new Error(
    `No existe la base local: ${localPath}`
  );
}

if(!fs.existsSync(cloudPath)){
  throw new Error(
    `No existe la base cloud: ${cloudPath}`
  );
}

const local=new DatabaseSync(localPath);
const cloud=new DatabaseSync(cloudPath,{readOnly:true});

local.exec('PRAGMA busy_timeout=5000;');

const stats={
  listingsInserted:0,
  listingsUpdated:0,
  analysesInserted:0,
  analysesUpdated:0,
  taskAnalysesInserted:0,
  taskAnalysesUpdated:0,
  sessionsInserted:0,
  sessionsUpdated:0,
  sessionItemsInserted:0,
  sessionItemsUpdated:0,
  taskRunsInserted:0,
  taskRunsUpdated:0,
  notificationsInserted:0,
  runLogsInserted:0,
  taskLastRunUpdated:0,
  skippedUnknownTasks:0,
  skippedRows:0
};

function newerOrEqual(a,b){
  if(!b)return true;
  if(!a)return false;
  return String(a)>String(b);
}

function rowDiffers(row,expected){
  return Object.entries(expected).some(
    ([key,value])=>(row?.[key]??null)!==(value??null)
  );
}

function minIso(a,b){
  if(!a)return b;
  if(!b)return a;
  return String(a)<=String(b)?a:b;
}

function maxIso(a,b){
  if(!a)return b;
  if(!b)return a;
  return String(a)>=String(b)?a:b;
}

const localTasks=local.prepare(
  'SELECT id,task_name,last_run_at FROM tasks'
).all();

const localTaskByName=new Map(
  localTasks.map(t=>[String(t.task_name),Number(t.id)])
);

const cloudTasks=cloud.prepare(
  'SELECT id,task_name,last_run_at FROM tasks'
).all();

const taskMap=new Map();
const unknownTaskNames=new Set();

for(const t of cloudTasks){
  const localId=localTaskByName.get(String(t.task_name));
  if(localId==null){
    unknownTaskNames.add(String(t.task_name));
    continue;
  }
  taskMap.set(Number(t.id),localId);
}

const listingMap=new Map();
const importedSessionIds=new Set();
const runMap=new Map();

const findListing=local.prepare(
  'SELECT * FROM listings WHERE source=? AND source_id=?'
);

const insertListing=local.prepare(`
  INSERT INTO listings(
    source,source_id,url,title,description,original_price,currency,
    price_eur,seller_name,seller_items,seller_sales,seller_reviews,
    image_url,status,raw_json,first_seen,last_seen,purchase_via
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const updateListing=local.prepare(`
  UPDATE listings SET
    url=?,title=?,description=?,original_price=?,currency=?,price_eur=?,
    seller_name=?,seller_items=?,seller_sales=?,seller_reviews=?,
    image_url=?,status=?,raw_json=?,first_seen=?,last_seen=?,purchase_via=?
  WHERE id=?
`);

const findAnalysis=local.prepare(
  'SELECT updated_at FROM analyses WHERE listing_id=?'
);

const insertAnalysis=local.prepare(`
  INSERT INTO analyses(
    listing_id,brand,model,authenticity_risk,liquidity,decision,
    opportunity_score,resale_low_eur,resale_high_eur,landed_cost_eur,
    net_profit_low_eur,net_profit_high_eur,notes,raw_json,updated_at,
    decision_reasons_es_json,preliminary_decision,verification_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const updateAnalysis=local.prepare(`
  UPDATE analyses SET
    brand=?,model=?,authenticity_risk=?,liquidity=?,decision=?,
    opportunity_score=?,resale_low_eur=?,resale_high_eur=?,landed_cost_eur=?,
    net_profit_low_eur=?,net_profit_high_eur=?,notes=?,raw_json=?,updated_at=?,
    decision_reasons_es_json=?,preliminary_decision=?,verification_json=?
  WHERE listing_id=?
`);

const findTaskAnalysis=local.prepare(
  'SELECT updated_at FROM task_analyses WHERE task_id=? AND listing_id=?'
);

const insertTaskAnalysis=local.prepare(`
  INSERT INTO task_analyses(
    task_id,listing_id,brand,model,authenticity_risk,liquidity,decision,
    opportunity_score,resale_low_eur,resale_high_eur,landed_cost_eur,
    net_profit_low_eur,net_profit_high_eur,notes,raw_json,updated_at,
    decision_reasons_es_json,preliminary_decision,verification_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const updateTaskAnalysis=local.prepare(`
  UPDATE task_analyses SET
    brand=?,model=?,authenticity_risk=?,liquidity=?,decision=?,
    opportunity_score=?,resale_low_eur=?,resale_high_eur=?,landed_cost_eur=?,
    net_profit_low_eur=?,net_profit_high_eur=?,notes=?,raw_json=?,updated_at=?,
    decision_reasons_es_json=?,preliminary_decision=?,verification_json=?
  WHERE task_id=? AND listing_id=?
`);

const findSession=local.prepare(
  'SELECT * FROM search_sessions WHERE id=?'
);

const insertSession=local.prepare(`
  INSERT INTO search_sessions(
    id,product_query,query_plan_json,source_status_json,status,
    started_at,finished_at,task_id
  ) VALUES(?,?,?,?,?,?,?,?)
`);

const updateSession=local.prepare(`
  UPDATE search_sessions SET
    product_query=?,query_plan_json=?,source_status_json=?,status=?,
    started_at=?,finished_at=?,task_id=?
  WHERE id=?
`);

const findSessionItem=local.prepare(
  'SELECT source_query FROM search_session_items WHERE session_id=? AND listing_id=?'
);

const insertSessionItem=local.prepare(`
  INSERT INTO search_session_items(session_id,listing_id,source_query)
  VALUES(?,?,?)
`);

const updateSessionItem=local.prepare(`
  UPDATE search_session_items
  SET source_query=COALESCE(?,source_query)
  WHERE session_id=? AND listing_id=?
`);

const findRunBySession=local.prepare(
  'SELECT * FROM task_runs WHERE session_id=? LIMIT 1'
);

const findRunWithoutSession=local.prepare(`
  SELECT * FROM task_runs
  WHERE task_id=? AND started_at=? AND session_id IS NULL
  LIMIT 1
`);

const insertTaskRun=local.prepare(`
  INSERT INTO task_runs(
    task_id,session_id,status,source_status_json,error,started_at,finished_at,
    debug_json,progress_pct,progress_stage,progress_detail,progress_updated_at,
    progress_eta_seconds,progress_current,progress_total
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const updateTaskRun=local.prepare(`
  UPDATE task_runs SET
    task_id=?,session_id=?,status=?,source_status_json=?,error=?,
    started_at=?,finished_at=?,debug_json=?,progress_pct=?,
    progress_stage=?,progress_detail=?,progress_updated_at=?,
    progress_eta_seconds=?,progress_current=?,progress_total=?
  WHERE id=?
`);

const insertNotification=local.prepare(`
  INSERT OR IGNORE INTO notifications(
    task_id,listing_id,run_id,kind,sent_to,sent_at
  ) VALUES(?,?,?,?,?,?)
`);

const findRunLog=local.prepare(`
  SELECT id FROM runs
  WHERE COALESCE(source,'')=COALESCE(?, '')
    AND COALESCE(kind,'')=COALESCE(?, '')
    AND COALESCE(summary,'')=COALESCE(?, '')
    AND created_at=?
  LIMIT 1
`);

const insertRunLog=local.prepare(
  'INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)'
);

const updateTaskLastRun=local.prepare(`
  UPDATE tasks
  SET last_run_at=?
  WHERE id=?
    AND (last_run_at IS NULL OR last_run_at<?)
`);

try{
  local.exec('BEGIN IMMEDIATE;');

  for(const c of cloud.prepare('SELECT * FROM listings ORDER BY id').all()){
    let l=findListing.get(c.source,c.source_id);

    if(!l){
      const r=insertListing.run(
        c.source,c.source_id,c.url,c.title,c.description,c.original_price,
        c.currency,c.price_eur,c.seller_name,c.seller_items,c.seller_sales,
        c.seller_reviews,c.image_url,c.status,c.raw_json,c.first_seen,
        c.last_seen,c.purchase_via
      );
      const localId=Number(r.lastInsertRowid);
      listingMap.set(Number(c.id),localId);
      stats.listingsInserted++;
      continue;
    }

    const localId=Number(l.id);
    listingMap.set(Number(c.id),localId);

    const cloudIsNewer=newerOrEqual(c.last_seen,l.last_seen);
    const pick=(cloudValue,localValue)=>
      cloudIsNewer && cloudValue!=null ? cloudValue : localValue;

    const mergedFirst=minIso(l.first_seen,c.first_seen);
    const mergedLast=maxIso(l.last_seen,c.last_seen);

    if(
      cloudIsNewer ||
      mergedFirst!==l.first_seen ||
      mergedLast!==l.last_seen
    ){
      updateListing.run(
        pick(c.url,l.url),
        pick(c.title,l.title),
        pick(c.description,l.description),
        pick(c.original_price,l.original_price),
        pick(c.currency,l.currency),
        pick(c.price_eur,l.price_eur),
        pick(c.seller_name,l.seller_name),
        pick(c.seller_items,l.seller_items),
        pick(c.seller_sales,l.seller_sales),
        pick(c.seller_reviews,l.seller_reviews),
        pick(c.image_url,l.image_url),
        pick(c.status,l.status),
        pick(c.raw_json,l.raw_json),
        mergedFirst,
        mergedLast,
        pick(c.purchase_via,l.purchase_via),
        localId
      );
      stats.listingsUpdated++;
    }
  }

  for(const c of cloud.prepare('SELECT * FROM analyses ORDER BY id').all()){
    const localListingId=listingMap.get(Number(c.listing_id));
    if(localListingId==null){
      stats.skippedRows++;
      continue;
    }

    const existing=findAnalysis.get(localListingId);

    if(!existing){
      insertAnalysis.run(
        localListingId,c.brand,c.model,c.authenticity_risk,c.liquidity,
        c.decision,c.opportunity_score,c.resale_low_eur,c.resale_high_eur,
        c.landed_cost_eur,c.net_profit_low_eur,c.net_profit_high_eur,
        c.notes,c.raw_json,c.updated_at,c.decision_reasons_es_json,
        c.preliminary_decision,c.verification_json
      );
      stats.analysesInserted++;
    }else if(newerOrEqual(c.updated_at,existing.updated_at)){
      updateAnalysis.run(
        c.brand,c.model,c.authenticity_risk,c.liquidity,c.decision,
        c.opportunity_score,c.resale_low_eur,c.resale_high_eur,
        c.landed_cost_eur,c.net_profit_low_eur,c.net_profit_high_eur,
        c.notes,c.raw_json,c.updated_at,c.decision_reasons_es_json,
        c.preliminary_decision,c.verification_json,localListingId
      );
      stats.analysesUpdated++;
    }
  }

  for(const c of cloud.prepare('SELECT * FROM task_analyses ORDER BY id').all()){
    const localTaskId=taskMap.get(Number(c.task_id));
    const localListingId=listingMap.get(Number(c.listing_id));

    if(localTaskId==null || localListingId==null){
      stats.skippedUnknownTasks+=localTaskId==null?1:0;
      stats.skippedRows++;
      continue;
    }

    const existing=findTaskAnalysis.get(localTaskId,localListingId);

    if(!existing){
      insertTaskAnalysis.run(
        localTaskId,localListingId,c.brand,c.model,c.authenticity_risk,
        c.liquidity,c.decision,c.opportunity_score,c.resale_low_eur,
        c.resale_high_eur,c.landed_cost_eur,c.net_profit_low_eur,
        c.net_profit_high_eur,c.notes,c.raw_json,c.updated_at,
        c.decision_reasons_es_json,c.preliminary_decision,c.verification_json
      );
      stats.taskAnalysesInserted++;
    }else if(newerOrEqual(c.updated_at,existing.updated_at)){
      updateTaskAnalysis.run(
        c.brand,c.model,c.authenticity_risk,c.liquidity,c.decision,
        c.opportunity_score,c.resale_low_eur,c.resale_high_eur,
        c.landed_cost_eur,c.net_profit_low_eur,c.net_profit_high_eur,
        c.notes,c.raw_json,c.updated_at,c.decision_reasons_es_json,
        c.preliminary_decision,c.verification_json,
        localTaskId,localListingId
      );
      stats.taskAnalysesUpdated++;
    }
  }

  for(const c of cloud.prepare('SELECT * FROM search_sessions ORDER BY started_at,id').all()){
    let localTaskId=null;

    if(c.task_id!=null){
      localTaskId=taskMap.get(Number(c.task_id));
      if(localTaskId==null){
        stats.skippedUnknownTasks++;
        stats.skippedRows++;
        continue;
      }
    }

    const existing=findSession.get(c.id);

    if(!existing){
      insertSession.run(
        c.id,c.product_query,c.query_plan_json,c.source_status_json,
        c.status,c.started_at,c.finished_at,localTaskId
      );
      stats.sessionsInserted++;
    }else if(rowDiffers(existing,{
      product_query:c.product_query,
      query_plan_json:c.query_plan_json,
      source_status_json:c.source_status_json,
      status:c.status,
      started_at:c.started_at,
      finished_at:c.finished_at,
      task_id:localTaskId
    })){
      updateSession.run(
        c.product_query,c.query_plan_json,c.source_status_json,c.status,
        c.started_at,c.finished_at,localTaskId,c.id
      );
      stats.sessionsUpdated++;
    }

    importedSessionIds.add(String(c.id));
  }

  for(const c of cloud.prepare(
    'SELECT session_id,listing_id,source_query FROM search_session_items'
  ).all()){
    if(!importedSessionIds.has(String(c.session_id))){
      stats.skippedRows++;
      continue;
    }

    const localListingId=listingMap.get(Number(c.listing_id));
    if(localListingId==null){
      stats.skippedRows++;
      continue;
    }

    const existing=findSessionItem.get(c.session_id,localListingId);

    if(!existing){
      insertSessionItem.run(c.session_id,localListingId,c.source_query);
      stats.sessionItemsInserted++;
    }else if(
      c.source_query!=null &&
      rowDiffers(existing,{source_query:c.source_query})
    ){
      updateSessionItem.run(c.source_query,c.session_id,localListingId);
      stats.sessionItemsUpdated++;
    }
  }

  for(const c of cloud.prepare('SELECT * FROM task_runs ORDER BY started_at,id').all()){
    const localTaskId=taskMap.get(Number(c.task_id));

    if(localTaskId==null){
      stats.skippedUnknownTasks++;
      stats.skippedRows++;
      continue;
    }

    if(c.session_id && !importedSessionIds.has(String(c.session_id))){
      stats.skippedRows++;
      continue;
    }

    const existing=c.session_id
      ? findRunBySession.get(c.session_id)
      : findRunWithoutSession.get(localTaskId,c.started_at);

    let localRunId;

    if(!existing){
      const r=insertTaskRun.run(
        localTaskId,c.session_id,c.status,c.source_status_json,c.error,
        c.started_at,c.finished_at,c.debug_json,c.progress_pct,
        c.progress_stage,c.progress_detail,c.progress_updated_at,
        c.progress_eta_seconds,c.progress_current,c.progress_total
      );
      localRunId=Number(r.lastInsertRowid);
      stats.taskRunsInserted++;
    }else{
      localRunId=Number(existing.id);
      if(rowDiffers(existing,{
        task_id:localTaskId,
        session_id:c.session_id,
        status:c.status,
        source_status_json:c.source_status_json,
        error:c.error,
        started_at:c.started_at,
        finished_at:c.finished_at,
        debug_json:c.debug_json,
        progress_pct:c.progress_pct,
        progress_stage:c.progress_stage,
        progress_detail:c.progress_detail,
        progress_updated_at:c.progress_updated_at,
        progress_eta_seconds:c.progress_eta_seconds,
        progress_current:c.progress_current,
        progress_total:c.progress_total
      })){
        updateTaskRun.run(
          localTaskId,c.session_id,c.status,c.source_status_json,c.error,
          c.started_at,c.finished_at,c.debug_json,c.progress_pct,
          c.progress_stage,c.progress_detail,c.progress_updated_at,
          c.progress_eta_seconds,c.progress_current,c.progress_total,
          localRunId
        );
        stats.taskRunsUpdated++;
      }
    }

    runMap.set(Number(c.id),localRunId);
  }

  for(const c of cloud.prepare('SELECT * FROM notifications ORDER BY id').all()){
    const localTaskId=Number(c.task_id)===0
      ? 0
      : taskMap.get(Number(c.task_id));

    const localListingId=listingMap.get(Number(c.listing_id));

    if(localTaskId==null || localListingId==null){
      stats.skippedRows++;
      continue;
    }

    const localRunId=c.run_id==null
      ? null
      : (runMap.get(Number(c.run_id)) ?? null);

    const r=insertNotification.run(
      localTaskId,localListingId,localRunId,c.kind,c.sent_to,c.sent_at
    );

    if(Number(r.changes||0)>0){
      stats.notificationsInserted++;
    }
  }

  for(const c of cloud.prepare('SELECT * FROM runs ORDER BY id').all()){
    const existing=findRunLog.get(
      c.source,c.kind,c.summary,c.created_at
    );

    if(existing)continue;

    insertRunLog.run(
      c.source,c.kind,c.summary,c.created_at
    );
    stats.runLogsInserted++;
  }

  for(const c of cloudTasks){
    const localTaskId=taskMap.get(Number(c.id));
    if(localTaskId==null || !c.last_run_at)continue;

    const r=updateTaskLastRun.run(
      c.last_run_at,localTaskId,c.last_run_at
    );

    if(Number(r.changes||0)>0){
      stats.taskLastRunUpdated++;
    }
  }

  local.exec('COMMIT;');
}catch(e){
  try{local.exec('ROLLBACK;')}catch{}
  throw e;
}finally{
  cloud.close();
}

const integrity=local.prepare('PRAGMA integrity_check').get();
const finalCounts=local.prepare(`
  SELECT
    (SELECT COUNT(*) FROM listings) AS listings,
    (SELECT COUNT(*) FROM task_analyses) AS task_analyses,
    (SELECT COUNT(*) FROM search_sessions) AS search_sessions,
    (SELECT COUNT(*) FROM task_runs) AS task_runs,
    (SELECT COUNT(*) FROM notifications) AS notifications
`).get();

local.close();

console.log('Cloud -> local merge completado.');
console.log(JSON.stringify({
  localPath,
  cloudPath,
  unknownTaskNames:[...unknownTaskNames],
  stats,
  integrity,
  finalCounts
},null,2));
