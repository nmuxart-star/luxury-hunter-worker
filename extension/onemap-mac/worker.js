const BASE='http://127.0.0.1:8210';
let polling=false;

async function bridge(path,token,method='GET',body){
  const response=await fetch(BASE+path,{method,headers:{authorization:`Bearer ${token}`,
    ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  if(!response.ok)throw new Error(`Puente HTTP ${response.status}`);
  return response.json();
}

async function snapshot(tabId,search){
  const [injection]=await chrome.scripting.executeScript({target:{tabId},func:(isSearch)=>{
    const html=document.implementation.createHTMLDocument(document.title);
    const copy=(selector,limit,parent)=>{
      for(const el of [...document.querySelectorAll(selector)].slice(0,limit))parent.append(el.cloneNode(true));
    };
    if(isSearch){
      copy('.shop-item',100,html.body);
    }else{
      copy('meta[property^="og:"]',20,html.head);
      copy('script[type="application/ld+json"]',5,html.head);
      copy('h1',2,html.body);
      copy('.vx-row',30,html.body);
    }
    // Enlace «siguiente» de la paginación de la propia web (solo en búsquedas).
    let nextHref='';
    if(isSearch){
      const links=[...document.querySelectorAll('a[href]')];
      const rel=document.querySelector('a[rel~="next"][href]');
      const byText=links.find(a=>/^\s*(next|siguiente|›|»|>|next\s*page)\s*$/i.test(a.textContent||'')||/next|siguiente/i.test(a.getAttribute('aria-label')||''));
      const el=rel||byText;
      if(el&&!/disabled/.test(el.className+(el.parentElement?.className||'')))nextHref=el.href;
    }
    return {status:200,finalUrl:location.href,title:document.title,nextHref,
      body:document.body?.innerText?.slice(0,30000)||'',html:html.documentElement.outerHTML};
  },args:[search]});
  return injection.result;
}

const BOT_CHECK=/confirme que es humano|confirm(e|a)? que es humano|confirm you are (a )?human|verify you are (a )?human|just a moment|人間であることを確認|are you a robot/i;
const isBotCheck=r=>BOT_CHECK.test(String(r?.title||'')+' '+String(r?.body||'').slice(0,400));

// Aviso en el ordenador cuando One Map pide el control «Confirme que es humano»:
// se trae la ventana al frente, se espera a que Nil lo resuelva y se vuelve a
// minimizar. Mientras tanto no se hace ninguna petición más.
let captchaWaiting=false;
const NOTE_ID='lh-onemap-captcha';
const ICON='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAcklEQVR42u3bMQEAIAwDwbjAFnKQgyj80BkL9IZfMt6erJnbuQAAAOAZzh5fBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQC8BwFAKBVBcObxuzn2EitAAAAAElFTkSuQmCC';
function notifyCaptcha(site='One Map'){
  try{chrome.notifications.create(NOTE_ID,{type:'basic',iconUrl:ICON,title:`${site} pide verificación`,
    message:site==='Xianyu'?'Pulsa aquí y resuelve el control de seguridad de Xianyu (deslizador). El bot espera.':'Pulsa aquí y resuelve «Confirme que es humano». El bot espera.',priority:2,requireInteraction:true})?.catch?.(()=>{});}catch{}
}
async function showJobWindow(){
  if(jobWindow)await chrome.windows.update(jobWindow.id,{state:'normal',focused:true}).catch(()=>{});
}
async function handleCaptcha(tabId,stillBlocked=tab=>BOT_CHECK.test(tab.title||''),site='One Map'){
  if(captchaWaiting)return;
  captchaWaiting=true;
  notifyCaptcha(site);
  await showJobWindow();
  const until=Date.now()+20*60_000;let lastNote=Date.now();let clearStreak=0;
  try{
    while(Date.now()<until){
      await sleep(3000);
      const tab=await chrome.tabs.get(tabId).catch(()=>null);
      if(!tab)break;
      const blockedNow=await stillBlocked(tab);
      clearStreak=blockedNow?0:clearStreak+1;
      if(clearStreak>=2&&tab.status==='complete'){
        await chrome.notifications.clear(NOTE_ID).catch(()=>{});
        break;
      }
      if(Date.now()-lastNote>5*60_000){notifyCaptcha(site);lastNote=Date.now();}
    }
  }finally{
    await chrome.notifications.clear(NOTE_ID).catch(()=>{});
    if(jobWindow)await chrome.windows.update(jobWindow.id,{state:'minimized'}).catch(()=>{});
    captchaWaiting=false;
  }
}
chrome.notifications?.onClicked.addListener(()=>{void showJobWindow();});

async function waitForPage(tabId,search){
  const until=Date.now()+(search?25_000:18_000);
  let last=null;
  while(Date.now()<until){
    try{
      last=await snapshot(tabId,search);
      if(isBotCheck(last))return last;
      if(search){
        if(/Search Results:\s*\d[\d,]*\s*Items?/i.test(last.body))return last;
      }else if(last.body.length>200&&(/Current Price|Item condition|Seller|現在価格/i.test(last.body))){
        return last;
      }
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  return last||{status:502,finalUrl:'',title:'',body:'La página no se cargó',html:''};
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// UNA sola ventana minimizada con UNA sola pestaña, para siempre: todas las
// consultas reutilizan esa pestaña (se navega a la URL nueva) y nunca se cierra
// ni se crean más. El id se guarda para reencontrarla si Chrome reinicia el
// service worker. Si Nil la cierra, se crea una nueva y vuelve a ser la única.
let jobWindow=null;
async function openHidden(url){
  if(!jobWindow){
    const {lhJobWindow}=await chrome.storage.local.get('lhJobWindow');
    if(lhJobWindow)jobWindow=lhJobWindow;
  }
  if(jobWindow){
    try{
      await chrome.windows.get(jobWindow.id);
      await chrome.tabs.update(jobWindow.firstTab,{url,active:false});
      await sleep(400);
      return {windowId:jobWindow.id,tabId:jobWindow.firstTab};
    }catch{jobWindow=null;}
  }
  const win=await chrome.windows.create({url,focused:false,state:'minimized'});
  jobWindow={id:win.id,firstTab:win.tabs[0].id};
  await chrome.storage.local.set({lhJobWindow:jobWindow});
  return {windowId:win.id,tabId:win.tabs[0].id};
}
// La pestaña se queda abierta (en blanco) hasta la siguiente consulta.
async function closeHidden(opened){
  if(!opened?.tabId)return;
  await chrome.tabs.update(opened.tabId,{url:'about:blank'}).catch(()=>{});
}
async function closeJobWindow(){}

async function waitLoaded(tabId,ms=30_000){
  const until=Date.now()+ms;
  let tab=null;
  while(Date.now()<until){
    tab=await chrome.tabs.get(tabId).catch(()=>null);
    if(tab?.status==='complete')return tab;
    await sleep(500);
  }
  return tab;
}

// Se ejecuta dentro de la página de Vestiaire: su propio buscador. Primero el
// modelo exacto (el nombre de modelo de Vestiaire más largo contenido en la
// búsqueda) y luego sus anuncios vendidos y en venta. Si Vestiaire responde
// con una verificación, se para: no se reintenta ni se resuelve nada.
async function vestiaireSearchInPage(q){
  const call=async(query,filters,{facets=[],limit=48,sortBy='relevance'}={})=>{
    const body={pagination:{offset:0,limit},fields:['name','description','model','brand','price','sold','likes','colors','condition','createdAt','link','pictures'],
      facets:{fields:facets,stats:[]},sortBy,filters,q:query,locale:{country:'ES',currency:'EUR',language:'es',sizeType:'FR'},mySizes:null};
    const r=await fetch('https://search.vestiairecollective.com/v1/product/search',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(r.status===403||r.status===429)throw Object.assign(new Error(`Vestiaire HTTP ${r.status}`),{blocked:true});
    if(!r.ok)throw new Error(`Vestiaire HTTP ${r.status}`);
    return r.json();
  };
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const norm=t=>String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  try{
    const nq=` ${norm(q)} `;
    const first=await call(q,{},{facets:['model'],limit:1});
    const models=(first.facets?.fields?.model||[]).filter(m=>norm(m.name)&&nq.includes(` ${norm(m.name)} `))
      .sort((a,b)=>norm(b.name).length-norm(a.name).length||b.count-a.count);
    const pick=models[0];
    if(!pick)return {status:200,body:JSON.stringify({query:q,model:null,items:[]})};
    // Vestiaire repite el mismo nombre de modelo con varios ids: todos cuentan.
    const ids=models.filter(m=>norm(m.name)===norm(pick.name)).map(m=>String(m.id));
    const filters={'model.id':ids};
    await wait(1200);
    const sold=await call('',{...filters,sold:['1']},{sortBy:'recency'});
    await wait(1200);
    // En venta, los más recientes primero (para las ofertas nuevas).
    const active=await call('',{...filters,sold:['0']},{sortBy:'recency'});
    const items=[...(sold.items||[]),...(active.items||[])];
    // Miniatura de la primera foto de cada anuncio (las mismas que muestra la
    // web), para que la IA compare cada referencia con el anuncio.
    const thumbs={};
    const toB64=async blob=>{const b=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(s);};
    const queue=items.filter(x=>x?.id&&Array.isArray(x.pictures)&&x.pictures[0]).slice(0,96);
    await Promise.all([0,1,2,3].map(async k=>{
      for(let i=k;i<queue.length;i+=4){
        try{
          const x=queue[i];
          const r=await fetch(`https://images.vestiairecollective.com/images/resized/w=256,q=60,f=jpg,${x.pictures[0]}`);
          if(!r.ok)continue;
          const blob=await r.blob();
          if(blob.size>0&&blob.size<60000)thumbs[x.id]=await toB64(blob);
        }catch{}
      }
    }));
    return {status:200,body:JSON.stringify({query:q,model:{id:pick.id,name:pick.name,count:pick.count},
      sold_total:sold.paginationStats?.totalHits??null,active_total:active.paginationStats?.totalHits??null,
      items,thumbs})};
  }catch(error){
    return {status:error.blocked?403:502,body:String(error.message||error)};
  }
}

async function handleVestiaire(job,token){
  let opened;
  const reply=payload=>bridge(`/result/${job.id}`,token,'POST',{url:job.url,finalUrl:job.url,title:'',html:'',...payload});
  try{
    opened=await openHidden(job.url);
    const tab=await waitLoaded(opened.tabId);
    await sleep(1500);
    const title=tab?.title||'';
    if(/just a moment|attention required|un momento|access denied|verify|verific/i.test(title)){
      return await reply({status:403,title,body:'Vestiaire pide una verificación en el navegador'});
    }
    const [injection]=await chrome.scripting.executeScript({target:{tabId:opened.tabId},world:'MAIN',
      func:vestiaireSearchInPage,args:[job.query]});
    await reply({...injection.result,title});
  }catch(error){
    await reply({status:502,body:String(error)}).catch(()=>{});
  }finally{
    await closeHidden(opened);
  }
}

// ── Xianyu (Goofish) desde el Chrome del Mac ──────────────────────────────
// Abre la búsqueda en la ventana minimizada de siempre, deja que la propia web
// pida sus resultados (el script xianyu-hook.js copia la respuesta), y ordena
// por «más nuevos» y filtra el precio como lo haría una persona.
const GOOFISH_BLOCK=/punish|baxia|captcha|_____tmd_____/i;
async function hookXianyu(){
  try{await chrome.scripting.unregisterContentScripts({ids:['lh-xianyu-hook']});}catch{}
  try{await chrome.scripting.registerContentScripts([{id:'lh-xianyu-hook',matches:['https://www.goofish.com/*'],js:['xianyu-hook.js'],world:'MAIN',runAt:'document_start',persistAcrossSessions:true}]);}
  catch(e){console.warn('Luxury Hunter Xianyu: no se pudo registrar el script',e.message);}
}
// Goofish puede pedir la verificación SIN cambiar de dirección: la API de búsqueda
// contesta con RGV587/USER_VALIDATE y la ventana de «baxia» sale encima de la página.
// En ese caso la ventana de trabajo (minimizada) hay que traerla al frente.
const XIANYU_RISK_JSON=/RGV587|FAIL_SYS_USER_VALIDATE|FAIL_SYS_ILLEGAL_ACCESS/;
const xianyuRiskText=t=>XIANYU_RISK_JSON.test(String(t||'').slice(0,3000));
async function xianyuOverlay(tabId){
  try{
    const [r]=await execMain({target:{tabId},world:'MAIN',func:()=>{
      // offsetParent vale null en elementos de posición fija (la ventana de verificación lo es):
      // se mira si ocupa espacio y no está oculta.
      const vis=el=>{if(!el)return false;const st=getComputedStyle(el);
        return el.getClientRects().length>0&&st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity)!==0;};
      return [...document.querySelectorAll('div.baxia-dialog-mask,[class*="baxia-dialog"],iframe[src*="punish"],iframe[src*="captcha"]')].some(vis);}});
    return !!r?.result;
  }catch{return false;}
}
async function xianyuStillBlocked(tabId,tab){
  return GOOFISH_BLOCK.test(tab?.url||'')||await xianyuOverlay(tabId);
}
// Bloqueo de red por tiempo: «We have detected unusual traffic from your network». No hay nada que resolver:
// no se trae la ventana al frente ni se espera; el bot avisa por Telegram y se para 4 h.
const XIANYU_HARD=/unusual traffic|异常流量|流量异常|网络环境.{0,8}异常/i;
async function xianyuHardBlock(tabId){
  try{
    const [r]=await execMain({target:{tabId},world:'MAIN',func:()=>(document.body?document.body.innerText:'').slice(0,3000)});
    return XIANYU_HARD.test(String(r?.result||''));
  }catch{return false;}
}
// Un poco de comportamiento humano al terminar: baja la página a ratos y se queda unos segundos mirando.
async function xianyuLinger(tabId){
  try{
    const steps=1+Math.floor(Math.random()*3);
    for(let i=0;i<steps;i++){
      await execMain({target:{tabId},world:'MAIN',args:[200+Math.floor(Math.random()*700)],func:dy=>window.scrollBy({top:dy,behavior:'smooth'})});
      await sleep(900+Math.random()*2200);
    }
  }catch{}
}
async function xianyuResponses(tabId){
  try{
    const [r]=await execMain({target:{tabId},world:'MAIN',func:()=>(window.__lhXY||[]).map(x=>x.text)});
    return r?.result||[];
  }catch{return [];}
}
async function xianyuWaitNew(tabId,have,ms){
  const until=Date.now()+ms;
  while(Date.now()<until){
    const list=await xianyuResponses(tabId);
    if(list.length>have)return list;
    const tab=await chrome.tabs.get(tabId).catch(()=>null);
    if(!tab||GOOFISH_BLOCK.test(tab.url||''))return null;
    await sleep(700);
  }
  return null;
}
// Gestos humanos (regla de Nil, 11-11-2026): el ratón pasa por encima, duda un momento y el clic tarda lo que tarda
// un dedo en apretar y soltar; el precio se escribe cifra a cifra con pausas irregulares.
// IMPORTANTE: todas las esperas se hacen AQUÍ (en el service worker) y no dentro de la página. La pestaña de trabajo
// está minimizada y Chrome frena los temporizadores de las páginas ocultas (hasta 1 por minuto pasados 5 min), de modo
// que una espera de 150 ms dentro de la página podía tardar un minuto y la búsqueda se agotaba (error 504).
// Último paso de la búsqueda (migas de pan): si algo se cuelga, el error dice dónde.
let lhCrumb='';
const crumb=s=>{lhCrumb=s;console.log('[LH]',s);};
// Ninguna llamada a la página puede quedarse esperando para siempre: a los 10 s se da por fallida.
const withTimeout=(promise,ms,label)=>Promise.race([promise,new Promise((_,rej)=>setTimeout(()=>rej(new Error('tiempo agotado: '+label)),ms))]);
const execMain=opts=>withTimeout(chrome.scripting.executeScript(opts),10_000,lhCrumb||'executeScript');
const pageStep=async(tabId,args,func)=>{
  try{const [r]=await withTimeout(chrome.scripting.executeScript({target:{tabId},world:'MAIN',args,func}),20_000,lhCrumb||'pageStep');return r?.result;}
  catch(e){console.log('[LH] pageStep falló en',lhCrumb,e?.message);return undefined;}
};
// GESTOS HUMANOS (regla de Nil, 11-11-2026): el ratón pasa por encima, duda un momento y el clic tarda lo que tarda un
// dedo; el precio se escribe cifra a cifra. Cada gesto es UNA sola llamada a la página y las pausas se hacen dentro
// con una espera activa (spin): los temporizadores de una ventana minimizada los frena Chrome y las llamadas
// repetidas a una página oculta van lentas, y eso colgaba la búsqueda. Si la búsqueda va justa de tiempo (human=false)
// se hace el mismo gesto al instante.
async function xianyuClick(tabId,text,human=true){
  const r=await pageStep(tabId,[text,human],(t,h)=>{
    const spin=ms=>{const e=performance.now()+ms;while(performance.now()<e){}};
    const el=[...document.querySelectorAll('div,span,a,li,button')].find(e=>e.children.length===0&&e.textContent.trim()===t);
    if(!el)return false;
    if(h){
      const b=el.getBoundingClientRect();
      const pt={bubbles:true,cancelable:true,view:window,clientX:b.left+b.width*(0.3+Math.random()*0.4),clientY:b.top+b.height*(0.3+Math.random()*0.4)};
      el.dispatchEvent(new MouseEvent('mouseover',pt));el.dispatchEvent(new MouseEvent('mouseenter',pt));el.dispatchEvent(new MouseEvent('mousemove',pt));
      spin(400+Math.random()*400);
      el.dispatchEvent(new MouseEvent('mousedown',{...pt,button:0,buttons:1}));
      spin(50+Math.random()*100);
      el.dispatchEvent(new MouseEvent('mouseup',{...pt,button:0}));
    }
    el.click();return true;});
  return !!r;
}
async function xianyuPrice(tabId,min,max,human=true){
  const r=await pageStep(tabId,[min,max,human],(lo,hi,h)=>{
    const spin=ms=>{const e=performance.now()+ms;while(performance.now()<e){}};
    const box=document.querySelector('div[class*="search-price-input-container"]');
    if(!box)return false;
    const inputs=[...box.querySelectorAll('input')];
    if(inputs.length<2)return false;
    const btn=box.querySelector('button')||document.querySelector('button[class*="search-price-confirm-button"]');
    if(!btn)return false;
    const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
    const type=(el,v)=>{
      el.focus();
      if(!h){d.set.call(el,String(v));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return;}
      spin(200+Math.random()*300);
      d.set.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}));
      let cur='';
      for(const ch of String(v)){
        cur+=ch;
        el.dispatchEvent(new KeyboardEvent('keydown',{key:ch,bubbles:true}));
        d.set.call(el,cur);el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new KeyboardEvent('keyup',{key:ch,bubbles:true}));
        spin(100+Math.random()*150);
      }
      el.dispatchEvent(new Event('change',{bubbles:true}));
      spin(500+Math.random()*500);
    };
    if(lo)type(inputs[0],lo);
    if(hi)type(inputs[1],hi);
    if(h){
      const bb=btn.getBoundingClientRect();
      const pt={bubbles:true,cancelable:true,view:window,clientX:bb.left+bb.width/2,clientY:bb.top+bb.height/2};
      btn.dispatchEvent(new MouseEvent('mouseover',pt));spin(300+Math.random()*300);
      btn.dispatchEvent(new MouseEvent('mousedown',{...pt,button:0,buttons:1}));spin(50+Math.random()*100);
      btn.dispatchEvent(new MouseEvent('mouseup',{...pt,button:0}));
    }
    btn.click();return true;});
  return !!r;
}
async function handleXianyu(job,token){
  let opened;
  const reply=payload=>bridge(`/result/${job.id}`,token,'POST',{url:job.url,finalUrl:job.url,title:'',html:'',...payload});
  try{
    crumb('hook');
    await hookXianyu();
    // Presupuesto de tiempo: los gestos humanos solo se hacen mientras la búsqueda va holgada (45 s); si no, al instante.
    const t0=Date.now();
    const human=()=>Date.now()-t0<45_000;
    // Navegación variada: ~1 de cada 3 veces entra primero por la portada, mira un momento y luego busca.
    const viaHome=Math.random()<0.33;
    crumb('abrir ventana');
    opened=await openHidden(viaHome?'https://www.goofish.com/':job.url);
    const tabId=opened.tabId;
    crumb('esperar carga');
    await waitLoaded(tabId);
    if(viaHome){
      crumb('portada');
      await sleep(2500+Math.random()*3500);
      await xianyuLinger(tabId);
      await chrome.tabs.update(tabId,{url:job.url});
      await sleep(800);
      await waitLoaded(tabId);
    }
    // Si el script que copia las respuestas no llegó a tiempo a esta página (carrera al registrarlo), se recarga una vez.
    if(!(await pageStep(tabId,[],()=>!!window.__lhXYHook))){
      crumb('recargar (sin script)');
      await chrome.tabs.reload(tabId).catch(()=>{});
      await sleep(800);
      await waitLoaded(tabId);
    }
    crumb('esperar resultados');
    let list=await xianyuWaitNew(tabId,0,40_000);
    let tab=await chrome.tabs.get(tabId).catch(()=>null);
    if(!list||GOOFISH_BLOCK.test(tab?.url||'')){
      const blocked=GOOFISH_BLOCK.test(tab?.url||'');
      const hard=await xianyuHardBlock(tabId);
      await reply({status:(blocked||hard)?403:502,finalUrl:tab?.url||job.url,title:tab?.title||'',
        body:JSON.stringify({blocked:(blocked||hard)?'risk':null,hard,login:/login|passport/i.test(tab?.url||''),text:null})});
      if(blocked&&!hard)await handleCaptcha(tabId,t=>GOOFISH_BLOCK.test(t.url||''),'Xianyu');
      return;
    }
    let text=list[list.length-1],sorted=false,priced=false;
    if(xianyuRiskText(text)){
      const hard=await xianyuHardBlock(tabId);
      await reply({status:200,finalUrl:tab?.url||job.url,title:tab?.title||'',body:JSON.stringify({text,sorted,priced,hard})});
      if(!hard)await handleCaptcha(tabId,t=>xianyuStillBlocked(tabId,t),'Xianyu');
      return;
    }
    crumb('ordenar');
    // Más nuevos primero.
    await sleep(900+Math.random()*900);
    if(await xianyuClick(tabId,'新发布',human())){
      await sleep(700+Math.random()*700);
      if(await xianyuClick(tabId,'最新',human())){
        const l2=await xianyuWaitNew(tabId,list.length,15_000);
        if(l2){list=l2;text=l2[l2.length-1];sorted=true;}
      }
    }
    crumb('precio');
    // Rango de precio de la tarea.
    if((job.minCny||job.maxCny)&&await xianyuPrice(tabId,job.minCny,job.maxCny,human())){
      const l3=await xianyuWaitNew(tabId,list.length,15_000);
      if(l3){list=l3;text=l3[l3.length-1];priced=true;}
    }
    tab=await chrome.tabs.get(tabId).catch(()=>null);
    crumb('final');
    const risky=xianyuRiskText(text)||await xianyuOverlay(tabId);
    const hard=risky&&await xianyuHardBlock(tabId);
    if(!risky&&human())await xianyuLinger(tabId);
    await reply({status:200,finalUrl:tab?.url||job.url,title:tab?.title||'',body:JSON.stringify({text,sorted,priced,hard})});
    if(risky&&!hard){
      await handleCaptcha(tabId,t=>xianyuStillBlocked(tabId,t),'Xianyu');
    }
  }catch(error){
    await reply({status:502,body:JSON.stringify({error:String(error?.message||error)})}).catch(()=>{});
  }finally{
    await closeHidden(opened);
  }
}

async function handle(job,token){
  if(job.kind==='vestiaire')return handleVestiaire(job,token);
  if(job.kind==='xianyu'){
    // Una búsqueda nunca puede dejar la extensión colgada: a los 90 s se contesta con error y se sigue.
    const reply=payload=>bridge(`/result/${job.id}`,token,'POST',{url:job.url,finalUrl:job.url,title:'',html:'',...payload}).catch(()=>{});
    let timer;
    const guard=new Promise(resolve=>{timer=setTimeout(()=>{reply({status:504,body:JSON.stringify({error:'La búsqueda se colgó en el paso: '+(lhCrumb||'?')})});resolve();},90_000);});
    try{await Promise.race([handleXianyu(job,token),guard]);}finally{clearTimeout(timer);}
    return;
  }
  const search=job.url.includes('/yahoo-auctions/search/');
  let opened;
  try{
    opened=await openHidden(job.url);
    const result=await waitForPage(opened.tabId,search);
    if(isBotCheck(result)){
      await bridge(`/result/${job.id}`,token,'POST',{...result,status:403,url:job.url}).catch(()=>{});
      await handleCaptcha(opened.tabId);
      return;
    }
    await bridge(`/result/${job.id}`,token,'POST',{...result,url:job.url});
  }catch(error){
    await bridge(`/result/${job.id}`,token,'POST',{url:job.url,status:502,
      finalUrl:job.url,title:'',body:String(error),html:''}).catch(()=>{});
  }finally{
    await closeHidden(opened);
  }
}

async function poll(){
  if(polling||captchaWaiting)return;
  polling=true;
  try{
    const {bridgeToken}=await chrome.storage.local.get('bridgeToken');
    if(!bridgeToken)return;
    await bridge('/heartbeat',bridgeToken,'POST');
    for(let i=0;i<30;i++){
      const {job}=await bridge('/next',bridgeToken);
      if(!job)break;
      // Mientras dura la búsqueda se sigue avisando al puente de que la extensión está viva (si no, a los 75 s parecía caída).
      const hb=setInterval(()=>bridge('/heartbeat',bridgeToken,'POST').catch(()=>{}),25_000);
      try{await handle(job,bridgeToken);}finally{clearInterval(hb);}
    }
  }catch(error){
    console.warn('Luxury Hunter One Map:',error.message);
  }finally{
    await closeJobWindow();
    polling=false;
  }
}

async function start(){
  await chrome.alarms.create('onemap-poll',{periodInMinutes:0.5});
  await poll();
}
// ── Enviar a Luxury Hunter Inbox el anuncio de la pestaña activa ───────────
// Al pulsar el icono de la extensión: se lee la ficha de ESA pestaña (solo
// esa, con el permiso activeTab) y se manda a la app en 127.0.0.1:8732.
const INBOX='http://127.0.0.1:8732';
async function badge(tabId,text,color,ms=0){
  try{
    await chrome.action.setBadgeBackgroundColor({tabId,color});
    await chrome.action.setBadgeText({tabId,text});
    if(ms)setTimeout(()=>chrome.action.setBadgeText({tabId,text:''}).catch(()=>{}),ms);
  }catch{}
}
async function sendTabToInbox(tab){
  const tabId=tab?.id;
  try{
    if(!tabId||!/^https?:/.test(tab.url||''))throw new Error('Abre un anuncio en esta pestaña y vuelve a pulsar el icono.');
    await badge(tabId,'…','#6b7280');
    const {bridgeToken}=await chrome.storage.local.get('bridgeToken');
    if(!bridgeToken)throw new Error('Falta la clave del puente: ábrela en las opciones de la extensión.');
    const [injection]=await chrome.scripting.executeScript({target:{tabId},files:['page-extractor.js']}).then(async()=>chrome.scripting.executeScript({target:{tabId},func:async()=>await lhExtractListing()}));
    const data=injection?.result;
    if(!data?.title)throw new Error('No he podido leer el anuncio: espera a que cargue la página.');
    let response;
    try{
      response=await fetch(`${INBOX}/api/manual/browser-import`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${bridgeToken}`},body:JSON.stringify(data)});
    }catch{throw new Error('La app Luxury Hunter Inbox no está abierta. Ábrela y vuelve a pulsar.');}
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(body.error||`La app respondió ${response.status}.`);
    await badge(tabId,'✓','#16a34a',5000);
  }catch(error){
    await badge(tabId,'!','#dc2626',8000);
    try{chrome.notifications.create('lh-inbox-error',{type:'basic',iconUrl:ICON,title:'No se ha enviado el anuncio',message:String(error?.message||error),priority:1});}catch{}
  }
}
chrome.action.onClicked.addListener(tab=>{void sendTabToInbox(tab);});

chrome.runtime.onInstalled.addListener(()=>{void hookXianyu();});
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='onemap-poll')void poll();});
void start();
