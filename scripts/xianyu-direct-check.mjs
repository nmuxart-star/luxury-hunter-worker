// Prueba del modo directo de Xianyu con el código real de Luxury Hunter:
// arranca server.mjs y lanza varias búsquedas solo en Xianyu (sin IA, sin
// emails). Usa data/ del checkout: pensado para GitHub Actions. Uso: node scripts/xianyu-direct-check.mjs "consulta 1" "consulta 2" ...
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port='8211';
const base=`http://127.0.0.1:${port}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const queries=process.argv.slice(2);

const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{
  ...process.env,
  PORT:port,
  DISABLE_SCHEDULER:'1',
  EXTRA_SOURCES:'off',
  OPENAI_API_KEY:'',GEMINI_API_KEY:'',SMTP_HOST:'',SMTP_USER:'',TELEGRAM_BOT_TOKEN:''
},stdio:['ignore','inherit','inherit']});

let failures=0;
try{
  for(let i=0;i<60;i++){
    try{const r=await fetch(`${base}/api/status`);if(r.ok)break;}catch{}
    await sleep(1000);
  }
  for(const q of queries){
    const t0=Date.now();
    const r=await fetch(`${base}/api/search/global`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({product:q,sources:['xianyu'],xianyu_queries:[q],maxItems:30})
    });
    const body=await r.json().catch(()=>({}));
    const st=body?.status?.xianyu||{};
    const secs=Math.round((Date.now()-t0)/1000);
    console.log(`\n=== "${q}" · HTTP ${r.status} · ${secs} s · ok=${st.ok} state=${st.state||'-'} mode=${st.mode||'-'} kept=${st.kept??'-'}`);
    if(st.warning)console.log(`AVISO: ${st.warning}`);
    if(st.error)console.log(`ERROR: ${st.error}`);
    console.log('perQuery:',JSON.stringify(st.perQuery||[]));
    for(const it of (body.items||[]).slice(0,3)){
      console.log(` - ${String(it.title||'').slice(0,50)} | ${it.original_price} CNY ≈ ${it.price_eur} € | img=${it.image_url?'sí':'no'} | ${it.url}`);
    }
    // Correcta = Xianyu respondió con normalidad (aunque no haya anuncios).
    const answered=(st.perQuery||[]).some(p=>Number(p.found)>0||JSON.stringify(p.ret||'').includes('SUCCESS'));
    if(!(st.ok===true&&st.mode==='direct'&&answered))failures++;
  }
}finally{
  child.kill('SIGKILL');
}
console.log(`\nResultado: ${queries.length-failures}/${queries.length} búsquedas correctas`);
process.exit(failures?1:0);
