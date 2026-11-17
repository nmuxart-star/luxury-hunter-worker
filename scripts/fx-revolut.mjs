// CAMBIO YUAN → EURO DE REVOLUT (regla de Nil, 14-11-2026)
// El bot usa el cambio de Revolut (https://www.revolut.com/currency-converter/convert-eur-to-cny-exchange-rate/) en vez del BCE, y lo
// vuelve a leer cada vez que arranca una tarea. Revolut no deja leer la página sin navegador (403), así que se abre con el
// Chromium del bot. Aquí: la lectura, el texto del mensaje diario de Telegram y las horas de Madrid. Funciones puras salvo fetch.
export const REVOLUT_URL='https://www.revolut.com/currency-converter/convert-eur-to-cny-exchange-rate/';

// «€1 = ¥7.2947» (o con coma) → 7.2947. Solo se acepta un cambio razonable de yuanes por euro.
export function parseRevolutRate(text){
  const m=String(text||'').match(/€\s?1\s?=\s?[^\d\s]{0,3}\s?(\d[\d.,]*)/);
  if(!m)return null;
  let t=m[1];
  if(t.includes(',')&&t.includes('.'))t=t.replace(/,/g,'');       // 1,234.56
  else t=t.replace(',','.');
  const n=Number(t);
  return Number.isFinite(n)&&n>3&&n<15?n:null;
}

// Abre la página de Revolut con el navegador (Playwright) y devuelve {rate, at}. browser = instancia de chromium ya lanzada.
export async function fetchRevolutRate(browser,{timeoutMs=40000}={}){
  const ctx=await browser.newContext({locale:'en-GB',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'});
  try{
    const page=await ctx.newPage();
    const resp=await page.goto(REVOLUT_URL,{waitUntil:'domcontentloaded',timeout:timeoutMs});
    if(resp&&resp.status()>=400)throw new Error(`Revolut HTTP ${resp.status()}`);
    for(let i=0;i<6;i++){                                              // la cifra tarda un momento en pintarse
      await page.waitForTimeout(i?1500:2500);
      const text=await page.evaluate(()=>document.body?document.body.innerText:'');
      const rate=parseRevolutRate(text);
      if(rate)return {rate,at:new Date().toISOString()};
    }
    throw new Error('Revolut: no se encontró el cambio en la página');
  }finally{
    await ctx.close().catch(()=>{});
  }
}

// ── Horas de Madrid ──────────────────────────────────────────────────────────────────────────────
export function madridParts(now=Date.now()){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
    .formatToParts(new Date(now)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour),minute:Number(p.minute),second:Number(p.second)};
}
// Milisegundos hasta las hh:mm de hoy en Madrid (negativo si ya pasó).
export function msUntilMadrid(hour,minute,now=Date.now()){
  const p=madridParts(now);
  return ((hour*60+minute)*60-(p.hour*60+p.minute)*60-p.second)*1000-(now%1000);
}
export const madridAfter=(hour,minute,now=Date.now())=>msUntilMadrid(hour,minute,now)<=0;

// ── Mensaje diario ───────────────────────────────────────────────────────────────────────────────
const f4=n=>n.toFixed(4).replace('.',',');
const f5=n=>n.toFixed(5).replace('.',',');
const pct=n=>(n>0?'+':n<0?'−':'')+Math.abs(n).toFixed(2).replace('.',',')+' %';
const dateEs=d=>d.split('-').reverse().join('/');
// today: {rate (¥ por €), date, time}; prev: {rate,date}|null; source: 'Revolut'|'BCE'. «Subir/bajar» se refiere al VALOR del yuan en euros
// (1 ¥ = X €); un yuan que baja hace que comprar en China salga más barato.
export function fxDailyMessage({today,prev=null,source='Revolut',note=''}){
  const eurPerYuan=1/today.rate;
  const lines=[`💱 <b>Yuan → euro · ${dateEs(today.date)} ${today.time||'13:30'}</b>`,
    `1 ¥ = <b>${f5(eurPerYuan)} €</b>   (1 € = ${f4(today.rate)} ¥)`];
  if(prev&&prev.rate>0){
    const prevEur=1/prev.rate;
    const change=(eurPerYuan/prevEur-1)*100;
    const same=Math.abs(change)<0.005;
    if(same)lines.push(`➖ Igual que ${dateEs(prev.date)} (${f5(prevEur)} €).`);
    else if(change>0)lines.push(`🔺 <b>Ha subido</b> ${pct(change)} frente a ${dateEs(prev.date)} (${f5(prevEur)} €): el yuan vale más, comprar en China sale algo más caro.`);
    else lines.push(`🔻 <b>Ha bajado</b> ${pct(change)} frente a ${dateEs(prev.date)} (${f5(prevEur)} €): el yuan vale menos, comprar en China sale algo más barato.`);
  }else lines.push('ℹ️ Primer mensaje: aún no hay cambio de ayer con el que comparar.');
  lines.push(`Fuente: ${source}${note?` · ${note}`:''}`);
  return lines.join('\n');
}
