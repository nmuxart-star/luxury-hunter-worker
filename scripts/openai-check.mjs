// Una llamada real de verificación "ligera" (modelo barato + búsqueda web
// en contexto bajo) para comprobar que funciona y cuánto cuesta.
const key=process.env.OPENAI_API_KEY;
const model=process.env.OPENAI_TRIAGE_MODEL||'gpt-6-luna';
const prices={'gpt-6-luna':[0.10,0.50],'gpt-6.1-sol':[2,10]};
const body={
  model,
  reasoning:{effort:'low'},
  input:[{role:'user',content:[{type:'input_text',text:'Find current second-hand resale asking prices in EUR for a Dior Lady Dior Mini in white lambskin on Vestiaire Collective or similar. Reply ONLY JSON {"low_eur":0,"high_eur":0,"sources":[]}'}]}],
  tools:[{type:'web_search',filters:{allowed_domains:['vestiairecollective.com','collectorsquare.com','rebelle.com','fashionphile.com']},search_context_size:'low'}],
  tool_choice:'required',
  include:['web_search_call.action.sources']
};
const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(body)});
const j=await r.json();
if(!r.ok){console.log('HTTP',r.status,JSON.stringify(j.error||j).slice(0,400));process.exit(1);}
const u=j.usage||{};
const [pi,po]=prices[model]||[0,0];
const searches=(j.output||[]).filter(o=>o.type==='web_search_call').length;
const usd=(u.input_tokens||0)/1e6*pi+(u.output_tokens||0)/1e6*po+searches*0.01;
const text=(j.output||[]).flatMap(o=>o.content||[]).map(c=>c.text||'').join('').slice(0,300);
console.log(`modelo ${model} · entrada ${u.input_tokens} · salida ${u.output_tokens} · búsquedas ${searches} · coste ≈ ${usd.toFixed(4)} $`);
console.log('respuesta:',text);
