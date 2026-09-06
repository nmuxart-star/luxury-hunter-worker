import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base='http://127.0.0.1:8200';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(method,url,body){
  const r=await fetch(base+url,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const txt=await r.text(); let data={}; try{data=txt?JSON.parse(txt):{}}catch{data={raw:txt}}
  if(!r.ok) throw new Error(`${method} ${url}: ${r.status} ${data.error||txt}`);
  return data;
}
function due(task,now=new Date()){
  if(!task.enabled) return false;
  if(task.interval_minutes){
    if(!task.last_run_at) return true;
    return now.getTime()-new Date(task.last_run_at).getTime() >= Number(task.interval_minutes)*60000-120000;
  }
  // GitHub Actions v1.5 is optimized for interval tasks. Cron tasks are left to the local scheduler.
  return false;
}
async function waitServer(){
  for(let i=0;i<60;i++){
    try{await api('GET','/api/status');return}catch{}
    await sleep(1000);
  }
  throw new Error('Luxury Hunter no arrancó en 60s');
}
async function waitRun(id){
  for(let i=0;i<360;i++){
    const {run}=await api('GET',`/api/task-runs/${id}`);
    if(run.status==='finished') return run;
    if(run.status==='error') throw new Error(run.error||`Run ${id} failed`);
    await sleep(5000);
  }
  throw new Error(`Timeout esperando run ${id}`);
}
const cfgPath=path.join(root,'cloud','config.json');
if(!fs.existsSync(cfgPath)) throw new Error('Falta cloud/config.json. Ejecuta npm run cloud:export en tu Mac y súbelo al repo.');
const cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,DISABLE_SCHEDULER:'1',PORT:'8200'},stdio:'inherit'});
let code=0;
try{
  await waitServer();
  console.log('Luxury Hunter cloud worker ready.');
  if(cfg.economics) await api('PUT','/api/economics',cfg.economics);
  const existing=(await api('GET','/api/tasks')).tasks||[];
  for(const t of cfg.tasks||[]){
    const old=existing.find(x=>x.task_name===t.task_name);
    if(old) await api('PATCH',`/api/tasks/${old.id}`,t);
    else await api('POST','/api/tasks',t);
  }
  const configuredNames=new Set((cfg.tasks||[]).map(t=>t.task_name));
  for(const old of existing){
    if(!configuredNames.has(old.task_name) && old.enabled){
      await api('PATCH',`/api/tasks/${old.id}`,{...old,enabled:false});
      console.log(`Disabled stale cloud task: ${old.task_name}`);
    }
  }
  const tasks=(await api('GET','/api/tasks')).tasks||[];
  const forceManual=process.env.GITHUB_EVENT_NAME==='workflow_dispatch';

  const runnable=forceManual
    ? tasks.filter(t=>t.enabled)
    : tasks.filter(t=>due(t));
  if(forceManual){
    console.log(`Manual workflow dispatch: forcing ${runnable.length}/${tasks.length} active tasks.`);
  }else{
    console.log(`Due tasks: ${runnable.length}/${tasks.length}`);
  }
  const taskResults=[];
  for(const task of runnable){
    console.log(`\n=== RUN ${task.task_name} ===`);
    try{
      const q=await api('POST',`/api/tasks/${task.id}/run`,{});
      const run=await waitRun(q.runId);
      taskResults.push({task_id:task.id,task_name:task.task_name,status:run.status,run_id:q.runId});
      console.log(`DONE ${task.task_name}: ${run.status}`);
    }catch(e){
      taskResults.push({task_id:task.id,task_name:task.task_name,status:'error',error:e?.message||String(e)});
      console.error(`FAILED ${task.task_name}:`,e?.message||e);
    }
  }

  const globalEmail=cfg.global_email||{};
  try{
    const digest=await api('POST','/api/email/global-digest',{
      to:globalEmail.to||null,
      force:forceManual,
      config:globalEmail
    });
    if(digest.sent){
      console.log(`Global 3h digest sent: ${digest.subject}; opportunities=${digest.opportunities??0}`);
    }else{
      console.log(`Global digest not sent: ${digest.reason||'unknown'}${digest.minutes_until_due!=null?`; due in ~${digest.minutes_until_due} min`:''}`);
    }
  }catch(e){
    code=1;
    console.error('Global digest failed:',e?.stack||e);
  }

  if(taskResults.some(x=>x.status==='error')){
    console.warn('One or more tasks failed, but the worker continues so state and the 3h digest cadence are preserved.');
  }
}catch(e){
  code=1; console.error(e?.stack||e);
}finally{
  if(child.exitCode===null && child.signalCode===null){
    child.kill('SIGTERM');

    await Promise.race([
      new Promise(resolve=>child.once('exit',resolve)),
      sleep(5000)
    ]);
  }

  if(child.exitCode===null && child.signalCode===null){
    console.log('Luxury Hunter server did not stop after SIGTERM; forcing shutdown.');
    child.kill('SIGKILL');

    await Promise.race([
      new Promise(resolve=>child.once('exit',resolve)),
      sleep(1000)
    ]);
  }

  console.log('Luxury Hunter cloud worker finished. Continuing GitHub workflow.');
  process.exit(code);
}
