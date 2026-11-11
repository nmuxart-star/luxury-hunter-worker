// VIGILANTE del bot (regla de Nil, 11-11-2026): el bot no puede quedarse parado sin que nadie lo note.
// Se ejecuta cada 10 min en un servidor de GitHub (no en el del bot) y:
//  · cancela una ejecución atascada (todos sus pasos terminaron y GitHub la sigue dando por «en curso»)
//    o que lleva más de 6 h;
//  · si no queda ninguna ejecución activa y la última acabó hace más de 15 min, lanza otra;
//  · avisa por Telegram solo cuando interviene (o si hay una ejecución en cola 45 min: el servidor puede estar apagado).
// No hace nada si el workflow está desactivado (Nil lo paró a propósito) o si la variable BOT_PAUSED vale «true».
import {execFileSync} from 'node:child_process';

const ACTIVE=['queued','in_progress','waiting','pending','requested'];
const STUCK_MS=10*60e3, RELAUNCH_AFTER_MS=15*60e3, MAX_RUN_MS=6*3600e3, QUEUE_ALERT_MIN_MS=45*60e3, QUEUE_ALERT_MAX_MS=55*60e3;

// Decisión pura (se prueba sin GitHub). runs: del más reciente al más antiguo.
export function decide({runs,jobsByRun={},now=Date.now(),workflowActive=true,paused=false}){
  const out={cancel:[],dispatch:null,alert:[],log:[]};
  if(paused){out.log.push('BOT_PAUSED: no hago nada.');return out;}
  if(!workflowActive){out.log.push('El workflow está desactivado (parada a propósito): no hago nada.');return out;}
  const active=runs.filter(r=>ACTIVE.includes(r.status));
  const keep=[];
  for(const r of active){
    const created=Date.parse(r.run_started_at||r.created_at)||now;
    const age=now-created;
    const steps=(jobsByRun[r.id]||[]).flatMap(j=>(j.steps||[]).map(s=>({...s,jobStatus:j.status})));
    const finishedStep=steps.filter(s=>(s.name==='Chain next run'||s.name==='Complete job')&&s.completed_at).map(s=>Date.parse(s.completed_at)).sort((a,b)=>b-a)[0];
    if(r.status==='in_progress'&&finishedStep&&now-finishedStep>STUCK_MS){
      out.cancel.push({id:r.id,reason:`atascada: sus pasos terminaron hace ${Math.round((now-finishedStep)/60e3)} min y GitHub la sigue dando por en curso`,force:true});
    }else if(age>MAX_RUN_MS){
      out.cancel.push({id:r.id,reason:`lleva ${Math.round(age/3600e3*10)/10} h en marcha`,force:true});
    }else{
      keep.push(r);
      if(r.status==='queued'&&age>=QUEUE_ALERT_MIN_MS&&age<QUEUE_ALERT_MAX_MS)out.alert.push(`Hay una ejecución del bot en cola desde hace ${Math.round(age/60e3)} min: el servidor del bot puede estar apagado o sin conexión.`);
    }
  }
  if(!keep.length){
    const last=runs.find(r=>!ACTIVE.includes(r.status));
    const since=last?now-(Date.parse(last.updated_at)||0):Infinity;
    if(out.cancel.length||since>=RELAUNCH_AFTER_MS){
      out.dispatch={reason:out.cancel.length?'tras cancelar la ejecución atascada':`ninguna ejecución activa y la última (${last?.conclusion||last?.status||'ninguna'}) acabó hace ${Number.isFinite(since)?Math.round(since/60e3)+' min':'mucho'}`};
    }else out.log.push(`Sin ejecución activa, pero la última acabó hace ${Math.round(since/60e3)} min: espero a que encadene sola.`);
  }else out.log.push(`${keep.length} ejecución(es) activa(s): todo en orden.`);
  return out;
}

async function main(){
  const repo=process.env.REPO,wf=process.env.WORKFLOW||'luxury-hunter.yml',ref=process.env.REF||'main';
  const gh=(...a)=>execFileSync('gh',a,{encoding:'utf8',maxBuffer:50e6});
  const api=p=>JSON.parse(gh('api',p));
  const telegram=async text=>{
    const t=process.env.TELEGRAM_BOT_TOKEN,c=process.env.TELEGRAM_CHAT_ID;
    if(!t||!c)return;
    try{await fetch(`https://api.telegram.org/bot${t}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:c,text})});}catch(e){console.log('Telegram falló:',e.message);}
  };
  const wfInfo=api(`repos/${repo}/actions/workflows/${wf}`);
  const runs=api(`repos/${repo}/actions/workflows/${wf}/runs?per_page=15`).workflow_runs||[];
  const jobsByRun={};
  for(const r of runs.filter(r=>r.status==='in_progress')){
    try{jobsByRun[r.id]=api(`repos/${repo}/actions/runs/${r.id}/jobs`).jobs||[];}catch{}
  }
  const d=decide({runs,jobsByRun,workflowActive:wfInfo.state==='active',paused:String(process.env.BOT_PAUSED||'').toLowerCase()==='true'});
  d.log.forEach(l=>console.log(l));
  for(const c of d.cancel){
    console.log(`Cancelo la ejecución ${c.id}: ${c.reason}`);
    try{gh('api','-X','POST',`repos/${repo}/actions/runs/${c.id}/${c.force?'force-cancel':'cancel'}`);}catch(e){console.log('No se pudo cancelar:',e.message.split('\n')[0]);}
    await telegram(`🛠️ Vigilante: he cancelado una ejecución del bot (${c.reason}).`);
  }
  for(const a of d.alert){console.log(a);await telegram(`⚠️ Vigilante: ${a}`);}
  if(d.dispatch){
    console.log(`Lanzo una ejecución nueva: ${d.dispatch.reason}`);
    try{
      gh('workflow','run',wf,'-R',repo,'--ref',ref,'-f','auto_chain=true');
      await telegram(`🔁 Vigilante: el bot estaba parado (${d.dispatch.reason}). Lo he relanzado.`);
    }catch(e){console.log('No se pudo lanzar (¿GitHub con problemas?):',e.message.split('\n')[0]);}
  }
}
if(process.argv[1]&&process.argv[1].endsWith('watchdog.mjs'))main().catch(e=>{console.error(e);process.exit(0);});
